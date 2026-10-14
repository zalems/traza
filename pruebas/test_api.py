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
        # Números con dos signos: 400, no 500.
        self.assertEqual(self.pedir("GET", "/api/red?red=--1")[0], 400)
        self.assertEqual(self.pedir("POST", "/api/equipos", {"elemento": "--4", "tipo": "splitter"})[0], 400)
        self.assertEqual(self.pedir("POST", "/api/fusiones/borrar", {"ids": ["--3"]})[0], 400)
        self.assertEqual(self.pedir("DELETE", "/api/fusiones/1?version=--2")[0], 400)
        salud = self.ok("GET", "/api/salud", usuario=None)
        self.assertEqual(salud["esquema"], api.ESQUEMA)
        # El código que atiende es el del archivo (el instalador lo compara con el instalado).
        import hashlib
        with open(os.path.join(RAIZ, "api", "ftth-api.py"), "rb") as fh:
            self.assertEqual(salud["codigo"], hashlib.sha256(fh.read()).hexdigest()[:12])
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
        store.close()

    def test_migracion_desde_030(self):
        # Una base de 0.3.0 (esquema 1) con datos pasa al esquema 2 sin perder nada.
        import sqlite3
        path = os.path.join(self.tmp.name, "vieja.db")
        c = sqlite3.connect(path, isolation_level=None)
        for sentencia in api.MIGRACIONES[1].split(";\n"):
            if sentencia.strip():
                c.execute(sentencia)
        c.execute("PRAGMA user_version = 1")
        t = "2026-10-13T12:00:00Z"
        c.execute("INSERT INTO redes (id, nombre, creado) VALUES (1, 'Vieja', ?)", (t,))
        c.execute("INSERT INTO elementos (id, red_id, tipo, nombre, lon, lat, creado, modificado, version) "
                  "VALUES (1, 1, 'botella', 'BOT-1', -58.17, -26.18, ?, ?, 1)", (t, t))
        c.execute("INSERT INTO cables (id, red_id, tipo, nombre, fibras, coords, nodos, creado, modificado, version) "
                  "VALUES (1, 1, 'troncal', 'T-1', 48, '[[-58.17,-26.18],[-58.16,-26.18]]', '[1,null]', ?, ?, 2)", (t, t))
        c.close()
        store = api.Store(path)
        conn = store.conn()
        self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 2)
        cable = api.Store.cable_feature(conn.execute("SELECT * FROM cables WHERE id = 1").fetchone())
        self.assertEqual((cable["properties"]["por_tubo"], cable["properties"]["colores"]), (0, "tia598"))
        elemento = api.Store.element_feature(conn.execute("SELECT * FROM elementos WHERE id = 1").fetchone())
        self.assertEqual(elemento["properties"]["carta"], {})
        red = store.network(1)
        self.assertEqual((red["equipos"], red["fusiones"]), ([], []))
        store.close()

    # ------------------------------------------------- fibras y cartas de empalme

    def test_estructura_de_fibras(self):
        red = self.nueva_red("Fibras")
        base = {"red": red, "coords": [[-58.17, -26.18], [-58.16, -26.18]]}
        cable = self.ok("POST", "/api/cables", {**base, "fibras": 48}, status=201)["cable"]["properties"]
        self.assertEqual((cable["por_tubo"], cable["colores"]), (0, "tia598"))
        abnt = self.ok("POST", "/api/cables", {**base, "fibras": 36, "por_tubo": 6, "colores": "abnt"}, status=201)
        self.assertEqual((abnt["cable"]["properties"]["por_tubo"], abnt["cable"]["properties"]["colores"]), (6, "abnt"))
        for malo in ({"por_tubo": -1}, {"por_tubo": 49}, {"por_tubo": "seis"}, {"colores": "rgb"}):
            with self.subTest(malo=malo):
                self.assertEqual(self.pedir("POST", "/api/cables", {**base, **malo})[0], 400)

    def armar(self, nombre):
        """Red de prueba: NODO -> T (pasa por BOT) -> NAP; R sale de BOT; D baja de NAP a CLI."""
        red = self.nueva_red(nombre)
        nodo = self.elemento(red, "nodo", -58.170, -26.180, "NODO")
        bot = self.elemento(red, "botella", -58.168, -26.180, "BOT")
        nap = self.elemento(red, "nap", -58.166, -26.180, "NAP")
        nap2 = self.elemento(red, "nap", -58.168, -26.178, "NAP-2")
        cli = self.elemento(red, "cliente", -58.166, -26.179, "CLI")
        poste = self.elemento(red, "poste", -58.167, -26.180, "P")

        def cable(nombre, elementos, fibras):
            coords = [e["geometry"]["coordinates"] for e in elementos]
            return self.ok("POST", "/api/cables", {"red": red, "nombre": nombre, "fibras": fibras, "coords": coords,
                                                   "nodos": [e["id"] for e in elementos]}, status=201)["cable"]
        t = cable("T", [nodo, bot, poste, nap], 24)
        r = cable("R", [bot, nap2], 12)
        d = cable("D", [nap, cli], 1)
        return {"red": red, "nodo": nodo, "bot": bot, "nap": nap, "nap2": nap2, "cli": cli, "poste": poste,
                "t": t["id"], "r": r["id"], "d": d["id"], "cables": {"t": t, "r": r, "d": d}}

    def unir(self, elemento, pares, status=201, **extra):
        body = {"elemento": elemento["id"], "pares": [{"a": a, "b": b} for a, b in pares], **extra}
        return self.ok("POST", "/api/fusiones", body, status=status)

    def test_fusiones(self):
        x = self.armar("Fusiones")
        t, r, bot = x["t"], x["r"], x["bot"]
        # T pasa por BOT (lados a y b); R empieza en BOT (solo lado b).
        res = self.unir(bot, [(f"c{t}:a:5", f"c{r}:b:1")])
        f1 = res["fusiones"][0]
        self.assertEqual((f1["elemento"], f1["a"], f1["b"], f1["tipo"], f1["creado_por"]),
                         (bot["id"], f"c{t}:a:5", f"c{r}:b:1", "fusion", "ana"))
        # Ya usada: 409 con la unión que la ocupa.
        code, data = self.pedir("POST", "/api/fusiones", {"elemento": bot["id"], "pares": [{"a": f"c{r}:b:1", "b": f"c{t}:b:5"}]},
                                usuario="beto")
        self.assertEqual(code, 409, data)
        self.assertEqual(data["fusiones"][0]["id"], f1["id"])
        malos = [
            ((f"c{r}:a:2", f"c{t}:b:6"), 409),     # R no llega a BOT por el lado a
            ((f"c{r}:b:13", f"c{t}:b:6"), 400),    # R tiene 12 fibras
            ((f"c{t}:b:6", f"c{t}:b:6"), 400),     # consigo misma
            ((f"c{t}:b:6", "c1:x:1"), 400),
            ((f"c{t}:b:6", "c0:a:1"), 400),
            ((f"c{t}:b:6", f"c{r}:b:0"), 400),
            ((f"c{t}:b:6", f"c{r}:b:2\n"), 400),
            ((f"c{t}:b:6", f"c{x['d']}:a:1"), 409),  # D no pasa por BOT
            ((f"c{t}:b:6", "q999:e:1"), 409),       # equipo inexistente
        ]
        for (a, b), status in malos:
            with self.subTest(a=a, b=b):
                code, data = self.pedir("POST", "/api/fusiones", {"elemento": bot["id"], "pares": [{"a": a, "b": b}]})
                self.assertEqual(code, status, data)
        # Un mismo extremo en dos pares del mismo pedido.
        code, _ = self.pedir("POST", "/api/fusiones", {"elemento": bot["id"], "pares": [
            {"a": f"c{t}:a:7", "b": f"c{r}:b:7"}, {"a": f"c{t}:a:7", "b": f"c{r}:b:8"}]})
        self.assertEqual(code, 400)
        # En un poste no hay carta.
        code, _ = self.pedir("POST", "/api/fusiones", {"elemento": x["poste"]["id"], "pares": [{"a": f"c{t}:a:1", "b": f"c{t}:b:1"}]})
        self.assertEqual(code, 400)
        # Varias juntas (seguir en orden) y la red las trae.
        lote = self.unir(bot, [(f"c{t}:a:{n}", f"c{r}:b:{n - 4}") for n in range(6, 10)])
        self.assertEqual(len(lote["fusiones"]), 4)
        red = self.ok("GET", f"/api/red?red={x['red']}")
        self.assertEqual(len(red["fusiones"]), 5)
        cambios = self.ok("GET", f"/api/cambios?red={x['red']}&desde={res['version']}")
        self.assertEqual(sorted(f["id"] for f in cambios["fusiones"]), sorted(f["id"] for f in lote["fusiones"]))
        # Quitar una con su versión; otra vez da 404. Deshacer el lote.
        self.ok("DELETE", f"/api/fusiones/{f1['id']}?version={f1['version']}")
        self.assertEqual(self.pedir("DELETE", f"/api/fusiones/{f1['id']}")[0], 404)
        borrar = self.ok("POST", "/api/fusiones/borrar", {"ids": [f["id"] for f in lote["fusiones"]] + [f1["id"]]})
        self.assertEqual(len(borrar["fusiones"]), 4)
        self.assertTrue(all(f["borrado"] and f["elemento"] == bot["id"] for f in borrar["fusiones"]))
        self.assertEqual(self.ok("GET", f"/api/red?red={x['red']}")["fusiones"], [])
        hist = self.ok("GET", f"/api/historial?red={x['red']}")["historial"]
        self.assertEqual(hist[0]["tabla"], "fusiones")
        self.assertEqual(hist[0]["accion"], "borrar")

    def test_splitters(self):
        x = self.armar("Splitters")
        nap, bot, nodo = x["nap"], x["bot"], x["nodo"]

        def equipo(elemento, status=201, **body):
            return self.ok("POST", "/api/equipos", {"elemento": elemento["id"], **body}, status=status)

        spl = equipo(nap, tipo="splitter", nombre="SPL-1", entradas=1, salidas=8,
                     datos={"modo": "plc", "conectores": True})["equipos"][0]
        self.assertEqual((spl["elemento"], spl["entradas"], spl["salidas"]), (nap["id"], 1, 8))
        fbt = equipo(bot, tipo="splitter", nombre="FBT-1", entradas=1, salidas=2, datos={"modo": "fbt", "relacion": "10/90"})
        self.assertEqual(fbt["equipos"][0]["datos"]["relacion"], "10/90")
        olt = equipo(nodo, tipo="olt", nombre="OLT-1", salidas=16, datos={"potencia": 4.5})["equipos"][0]
        self.assertEqual((olt["entradas"], olt["salidas"]), (0, 16))
        malos = [
            (nap, {"tipo": "splitter", "entradas": 1, "salidas": 3}),
            (nap, {"tipo": "splitter", "entradas": 3, "salidas": 8}),
            (nap, {"tipo": "splitter", "entradas": 1, "salidas": 2, "datos": {"modo": "fbt", "relacion": "10/80"}}),
            (nap, {"tipo": "splitter", "entradas": 1, "salidas": 8, "datos": {"modo": "fbt", "relacion": "10/90"}}),
            (nap, {"tipo": "splitter", "entradas": 1, "salidas": 8, "datos": {"modo": "plc", "relacion": "10/90"}}),
            (nap, {"tipo": "splitter", "datos": {"conectores": "si"}}),
            (bot, {"tipo": "olt", "salidas": 8}),
            (nodo, {"tipo": "olt", "salidas": 0}),
            (x["poste"], {"tipo": "splitter"}),
            (nap, {"tipo": "router"}),
        ]
        for elemento, body in malos:
            with self.subTest(body=body):
                code, data = self.pedir("POST", "/api/equipos", {"elemento": elemento["id"], **body})
                self.assertEqual(code, 400, data)
        # Entrada del splitter con la fibra 3 del troncal (que termina en la NAP),
        # salida 6 con conectores hacia la bajada (que empieza en la NAP).
        t, d = x["t"], x["d"]
        uniones = self.unir(nap, [(f"c{t}:a:3", f"q{spl['id']}:e:1"), (f"q{spl['id']}:s:6", f"c{d}:b:1")])["fusiones"]
        self.assertEqual([u["tipo"] for u in uniones], ["conector", "conector"])
        self.assertEqual(self.pedir("POST", "/api/fusiones", {"elemento": nap["id"], "pares": [
            {"a": f"q{spl['id']}:s:1", "b": f"q{spl['id']}:e:1"}]})[0], 400)
        # Achicar a 1x4 dejaría colgada la salida 6; a 1x16 se puede.
        code, data = self.pedir("PUT", f"/api/equipos/{spl['id']}", {"salidas": 4, "version": spl["version"]})
        self.assertEqual(code, 409, data)
        grande = self.ok("PUT", f"/api/equipos/{spl['id']}", {"salidas": 16, "version": spl["version"]})["equipos"][0]
        self.assertEqual(grande["salidas"], 16)
        self.assertEqual(self.pedir("PUT", f"/api/equipos/{spl['id']}", {"tipo": "olt"})[0], 400)
        code, data = self.pedir("PUT", f"/api/equipos/{spl['id']}", {"nombre": "x", "version": spl["version"]})
        self.assertEqual(code, 409)
        self.assertEqual(data["actual"]["salidas"], 16)
        # Borrar el splitter se lleva sus uniones.
        res = self.ok("DELETE", f"/api/equipos/{spl['id']}?version={grande['version']}")
        self.assertEqual(sorted(f["id"] for f in res["fusiones"]), sorted(u["id"] for u in uniones))
        red = self.ok("GET", f"/api/red?red={x['red']}")
        self.assertEqual(sorted(e["id"] for e in red["equipos"]), sorted([fbt["equipos"][0]["id"], olt["id"]]))
        self.assertEqual(red["fusiones"], [])

    def test_fusiones_y_cambios_en_los_cables(self):
        x = self.armar("Cambios de cable")
        t, r, bot = x["t"], x["r"], x["bot"]
        self.unir(bot, [(f"c{t}:b:20", f"c{r}:b:2")])
        cable_t = x["cables"]["t"]
        v = cable_t["properties"]["version"]
        # Bajar a 12 fibras dejaría colgada la fibra 20.
        code, data = self.pedir("PUT", f"/api/cables/{t}", {"fibras": 12, "version": v})
        self.assertEqual(code, 409, data)
        self.assertIn("BOT", data["error"])
        self.ok("PUT", f"/api/cables/{t}", {"fibras": 24, "por_tubo": 6, "colores": "abnt", "version": v})
        # Sacar a T de BOT con un trazado nuevo deja la unión sin cable: rechazado.
        nodo, nap = x["nodo"], x["nap"]
        actual = self.ok("GET", f"/api/red?red={x['red']}")["cables"]["features"]
        v = next(c for c in actual if c["id"] == t)["properties"]["version"]
        code, data = self.pedir("PUT", f"/api/cables/{t}", {
            "coords": [nodo["geometry"]["coordinates"], nap["geometry"]["coordinates"]],
            "nodos": [nodo["id"], nap["id"]], "version": v})
        self.assertEqual(code, 409, data)
        # Cortar T en BOT (que termine ahí) también saca el lado b, que tiene la unión.
        code, _ = self.pedir("PUT", f"/api/cables/{t}", {
            "coords": [nodo["geometry"]["coordinates"], bot["geometry"]["coordinates"]],
            "nodos": [nodo["id"], bot["id"]], "version": v})
        self.assertEqual(code, 409)
        # Un trazado que sigue pasando por BOT se guarda.
        self.ok("PUT", f"/api/cables/{t}", {
            "coords": [nodo["geometry"]["coordinates"], [-58.169, -26.1805], bot["geometry"]["coordinates"],
                       nap["geometry"]["coordinates"]],
            "nodos": [nodo["id"], None, bot["id"], nap["id"]], "version": v})
        # Pasar dos veces por la botella no se admite; por un poste, sí.
        p = x["poste"]
        coords = [nodo["geometry"]["coordinates"], bot["geometry"]["coordinates"], p["geometry"]["coordinates"],
                  bot["geometry"]["coordinates"]]
        code, data = self.pedir("POST", "/api/cables", {"red": x["red"], "coords": coords,
                                                        "nodos": [nodo["id"], bot["id"], p["id"], bot["id"]]})
        self.assertEqual(code, 400, data)
        self.assertIn("dos veces", data["error"])
        coords = [p["geometry"]["coordinates"], bot["geometry"]["coordinates"], p["geometry"]["coordinates"]]
        self.ok("POST", "/api/cables", {"red": x["red"], "coords": coords, "nodos": [p["id"], bot["id"], p["id"]]},
                status=201)
        # Borrar el cable R se lleva sus uniones (y avisa en la respuesta y en los cambios).
        actual = self.ok("GET", f"/api/red?red={x['red']}")
        v_r = next(c for c in actual["cables"]["features"] if c["id"] == r)["properties"]["version"]
        borrado = self.ok("DELETE", f"/api/cables/{r}?version={v_r}")
        self.assertEqual(len(borrado["fusiones"]), 1)
        cambios = self.ok("GET", f"/api/cambios?red={x['red']}&desde={actual['version']}")
        self.assertEqual(cambios["fusiones"][0]["borrado"], True)

    def test_carta_y_tipo_del_elemento(self):
        x = self.armar("Carta")
        t, r, bot, nodo = x["t"], x["r"], x["bot"], x["nodo"]
        lados = {"lados": {f"c{t}:a": "i", f"c{t}:b": "d", f"c{r}:b": "i"}}
        e = self.ok("PUT", f"/api/elementos/{bot['id']}", {"carta": lados})["elemento"]
        self.assertEqual(e["properties"]["carta"], lados)
        for malo in ({"lados": {"x": "i"}}, {"lados": {f"c{t}:a": "arriba"}}, {"lados": []}, "texto"):
            with self.subTest(malo=malo):
                self.assertEqual(self.pedir("PUT", f"/api/elementos/{bot['id']}", {"carta": malo})[0], 400)
        hist = self.ok("GET", f"/api/historial?red={x['red']}&limite=1")["historial"]
        self.assertEqual(hist[0]["accion"], "ordenar")
        # Con uniones, la botella no puede pasar a poste; con OLT, el nodo no puede pasar a caja.
        self.unir(bot, [(f"c{t}:a:1", f"c{r}:b:1")])
        self.assertEqual(self.pedir("PUT", f"/api/elementos/{bot['id']}", {"tipo": "poste"})[0], 409)
        self.ok("PUT", f"/api/elementos/{bot['id']}", {"tipo": "caja"})
        self.ok("POST", "/api/equipos", {"elemento": nodo["id"], "tipo": "olt", "salidas": 8}, status=201)
        self.assertEqual(self.pedir("PUT", f"/api/elementos/{nodo['id']}", {"tipo": "caja"})[0], 409)
        # Un poste por el que un cable pasa dos veces no puede pasar a caja.
        p = x["poste"]
        coords = [p["geometry"]["coordinates"], bot["geometry"]["coordinates"], p["geometry"]["coordinates"]]
        self.ok("POST", "/api/cables", {"red": x["red"], "coords": coords, "nodos": [p["id"], bot["id"], p["id"]]}, status=201)
        code, data = self.pedir("PUT", f"/api/elementos/{p['id']}", {"tipo": "caja"})
        self.assertEqual(code, 409, data)
        self.assertIn("dos veces", data["error"])
        # Borrar la botella se lleva su carta.
        self.ok("POST", "/api/equipos", {"elemento": bot["id"], "tipo": "splitter", "salidas": 4}, status=201)
        res = self.ok("DELETE", f"/api/elementos/{bot['id']}")
        self.assertEqual((len(res["fusiones"]), len(res["equipos"])), (1, 1))
        red = self.ok("GET", f"/api/red?red={x['red']}")
        self.assertEqual(red["fusiones"], [])
        self.assertEqual([e["tipo"] for e in red["equipos"]], ["olt"])

    def test_disposicion_de_la_carta(self):
        x = self.armar("Disposición")
        t, r, bot = x["t"], x["r"], x["bot"]
        url = f"/api/elementos/{bot['id']}"
        poner = lambda carta, **kw: self.ok("PUT", url, {"carta": carta}, **kw)["elemento"]["properties"]["carta"]  # noqa: E731
        lados = {f"c{t}:a": "i", f"c{r}:b": "d"}
        self.assertEqual(poner({"lados": lados}), {"lados": lados})
        # Cada parte llega por separado y lo demás queda como estaba.
        orden = [f"c{r}:b", f"c{t}:a", "q7"]
        self.assertEqual(poner({"orden": orden}), {"lados": lados, "orden": orden})
        c = poner({"pos": {f"c{t}:a": [10.4, -20], f"c{r}:b": [300, 40]}})
        self.assertEqual(c["pos"], {f"c{t}:a": [10, -20], f"c{r}:b": [300, 40]})
        # Las posiciones se suman; null quita una.
        c = poner({"pos": {f"c{t}:a": [50, 60], "q7": [0, 0], f"c{r}:b": None}})
        self.assertEqual(c["pos"], {f"c{t}:a": [50, 60], "q7": [0, 0]})
        self.assertEqual((c["lados"], c["orden"]), (lados, orden))
        # Columnas o libre es de cada dispositivo: no se guarda (se descarta).
        c = poner({"modo": "libre"})
        self.assertNotIn("modo", c)
        self.assertEqual(c["pos"], {f"c{t}:a": [50, 60], "q7": [0, 0]})
        self.assertEqual(poner({"pos": None, "orden": None}), {"lados": lados})
        self.assertEqual(poner({}), {"lados": lados})  # sin cambios
        self.assertEqual(poner(None), {})  # todo automático otra vez
        # Lo que no es de la disposición se descarta; lo mal formado es 400.
        self.assertEqual(poner({"color": "rojo", "lados": None}), {})
        malos = [
            {"orden": "c1:a"}, {"orden": ["c1:a", "c1:a"]}, {"orden": ["x"]}, {"orden": [f"c{t}:c"]},
            {"pos": []}, {"pos": {"c1:a": [1]}}, {"pos": {"c1:a": [1, "2"]}},
            {"pos": {"c1:a": [1, True]}}, {"pos": {"c1:a": [1, 1e9]}}, {"pos": {"zz": [1, 2]}},
            {"lados": []}, {"lados": {"q3": "i"}},
        ]
        for malo in malos:
            with self.subTest(malo=malo):
                self.assertEqual(self.pedir("PUT", url, {"carta": malo})[0], 400)
        demasiadas = {f"q{i}": [i, i] for i in range(1, 802)}
        self.assertEqual(self.pedir("PUT", url, {"carta": {"pos": demasiadas}})[0], 400)
        # Acomodar no exige versión ni pisa el resto del elemento.
        self.ok("PUT", url, {"nombre": "BOT-1"})
        e = self.ok("PUT", url, {"carta": {"orden": ["q1"]}})["elemento"]
        self.assertEqual((e["properties"]["nombre"], e["properties"]["carta"]), ("BOT-1", {"orden": ["q1"]}))
        # Un elemento nuevo puede llegar con su disposición.
        nuevo = self.elemento(x["red"], "caja", -58.1, -26.1, "CJ", carta={"pos": {"q1": [1, 2]}})
        self.assertEqual(nuevo["properties"]["carta"], {"pos": {"q1": [1, 2]}})

    def test_pasar_una_union_a_otra_fibra(self):
        x = self.armar("Mover uniones")
        t, r, bot, nap = x["t"], x["r"], x["bot"], x["nap"]
        f = self.unir(bot, [(f"c{t}:a:1", f"c{r}:b:1")])["fusiones"][0]
        g = self.unir(bot, [(f"c{t}:a:2", f"c{r}:b:2")])["fusiones"][0]
        url = f"/api/fusiones/{f['id']}"
        movida = self.ok("PUT", url, {"b": f"c{r}:b:3", "version": f["version"]}, usuario="beto")["fusiones"][0]
        self.assertEqual((movida["id"], movida["a"], movida["b"], movida["tipo"], movida["modificado_por"], movida["creado_por"]),
                         (f["id"], f"c{t}:a:1", f"c{r}:b:3", "fusion", "beto", "ana"))
        # Con la versión vieja: 409 con la unión actual.
        code, data = self.pedir("PUT", url, {"b": f"c{r}:b:4", "version": f["version"]})
        self.assertEqual(code, 409, data)
        # A una fibra ya unida: 409 con la unión que la ocupa.
        code, data = self.pedir("PUT", url, {"a": f"c{t}:a:2"})
        self.assertEqual(code, 409, data)
        self.assertEqual(data["fusiones"][0]["id"], g["id"])
        malos = [
            ({"a": f"c{r}:b:3"}, 400),          # consigo misma
            ({"b": f"c{r}:b:13"}, 400),         # R tiene 12 fibras
            ({"b": f"c{r}:a:5"}, 409),          # R no llega a BOT por el lado a
            ({"b": f"c{x['d']}:a:1"}, 409),     # D no pasa por BOT
            ({"b": "nada"}, 400),
            ({}, 400),
        ]
        for cuerpo, esperado in malos:
            with self.subTest(cuerpo=cuerpo):
                self.assertEqual(self.pedir("PUT", url, cuerpo)[0], esperado)
        self.assertEqual(self.pedir("PUT", "/api/fusiones/99999", {"a": f"c{t}:a:9"})[0], 404)
        # Sin cambios: responde la misma unión.
        igual = self.ok("PUT", url, {"a": f"c{t}:a:1"})["fusiones"][0]
        self.assertEqual(igual["version"], movida["version"])
        # A un splitter con conectores: pasa a ser conector; de vuelta a una fibra, fusión.
        spl = self.ok("POST", "/api/equipos", {"elemento": nap["id"], "tipo": "splitter", "salidas": 8,
                                                "datos": {"modo": "plc", "conectores": True}}, status=201)["equipos"][0]
        # En la NAP termina T (lado a) y empieza D (lado b).
        h = self.unir(nap, [(f"c{t}:a:1", f"c{x['d']}:b:1")])["fusiones"][0]
        self.assertEqual(h["tipo"], "fusion")
        h = self.ok("PUT", f"/api/fusiones/{h['id']}", {"a": f"q{spl['id']}:s:3"})["fusiones"][0]
        self.assertEqual((h["a"], h["tipo"]), (f"q{spl['id']}:s:3", "conector"))
        h = self.ok("PUT", f"/api/fusiones/{h['id']}", {"a": f"c{t}:a:4"})["fusiones"][0]
        self.assertEqual(h["tipo"], "fusion")
        self.assertEqual(self.pedir("PUT", f"/api/fusiones/{h['id']}", {"a": f"q{spl['id']}:s:1", "b": f"q{spl['id']}:e:1"})[0], 400)
        # Queda en el historial con lo que había antes, y los demás lo ven en los cambios.
        hist = self.ok("GET", f"/api/historial?red={x['red']}&limite=1")["historial"][0]
        self.assertEqual((hist["accion"], hist["tabla"]), ("editar", "fusiones"))
        self.assertEqual(hist["detalle"]["antes"]["a"], f"q{spl['id']}:s:3")
        cambios = self.ok("GET", f"/api/cambios?red={x['red']}&desde={h['version'] - 1}")
        self.assertEqual([c["id"] for c in cambios["fusiones"]], [h["id"]])

    def test_acomodar_no_choca_con_editar(self):
        x = self.armar("Acomodar y editar")
        bot = x["bot"]
        url = f"/api/elementos/{bot['id']}"
        v0 = bot["properties"]["version"]
        # Otro acomoda la carta dos veces mientras uno tiene la ficha abierta.
        self.ok("PUT", url, {"carta": {"orden": [f"c{x['r']}:b"]}}, usuario="beto")
        self.ok("PUT", url, {"carta": {"pos": {f"c{x['r']}:b": [10, 20]}}}, usuario="beto")
        e = self.ok("PUT", url, {"notas": "revisada", "version": v0})["elemento"]
        self.assertEqual(e["properties"]["notas"], "revisada")
        self.assertEqual(e["properties"]["carta"]["pos"], {f"c{x['r']}:b": [10, 20]})  # lo acomodado queda
        # Pero si otro editó de verdad, sí choca.
        v1 = e["properties"]["version"]
        self.ok("PUT", url, {"nombre": "BOT-B"}, usuario="beto")
        self.ok("PUT", url, {"carta": {"orden": []}}, usuario="beto")
        self.assertEqual(self.pedir("PUT", url, {"notas": "otra", "version": v1})[0], 409)
        # Acomodar con una versión vieja también choca (la disposición sí se controla).
        self.assertEqual(self.pedir("PUT", url, {"carta": {"orden": []}, "version": v1})[0], 409)
        # Borrar con la versión de antes de que solo se acomodara: se puede.
        nap2 = x["nap2"]
        u2 = f"/api/elementos/{nap2['id']}"
        self.ok("PUT", u2, {"carta": {"pos": {"q1": [0, 0]}}}, usuario="beto")
        self.ok("DELETE", f"{u2}?version={nap2['properties']['version']}")
        # El historial de acomodar es corto: la versión y la disposición de antes.
        hist = [h for h in self.ok("GET", f"/api/historial?red={x['red']}&limite=50")["historial"] if h["accion"] == "ordenar"]
        self.assertTrue(hist)
        self.assertEqual(set(hist[0]["detalle"]["antes"]["properties"]), {"version", "carta"})

    def test_numeros_imposibles(self):
        red = self.nueva_red("Números")
        e = self.elemento(red, "caja", -58.1, -26.1, "CJ")
        url = f"/api/elementos/{e['id']}"
        for carta in ({"pos": {"q1": [10 ** 400, 0]}}, {"pos": {"q1": [1.5e308 * 10, 0]}}):
            with self.subTest(carta=carta):
                self.assertEqual(self.pedir("PUT", url, {"carta": carta})[0], 400)
        self.assertEqual(self.pedir("PUT", url, {"lon": 10 ** 400, "lat": 0})[0], 400)
        self.assertEqual(self.pedir("PUT", url, raw=b'{"lon": NaN, "lat": 0}', headers={"Content-Type": "application/json"})[0], 400)

    def test_salud_con_y_sin_clave(self):
        api.Handler.secreto = "k" * 40
        try:
            salud = self.ok("GET", "/api/salud", usuario=None)
            self.assertNotIn("codigo", salud)  # sin la clave no se informa
            salud = self.ok("GET", "/api/salud", usuario=None, headers={"X-Ftth-Secreto": "k" * 40})
            self.assertEqual(salud["codigo"], api.CODIGO)
        finally:
            api.Handler.secreto = ""


if __name__ == "__main__":
    unittest.main()
