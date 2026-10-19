"""Pruebas del servicio de sesión (auth/ftth-auth.py): login, cookie, lo que le
dice a nginx (X-Usuario y X-Redes) y la migración de una base anterior a 0.8.0."""

import http.cookiejar
import importlib.util
import json
import os
import socket
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

AUTH_PY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "auth", "ftth-auth.py")
spec = importlib.util.spec_from_file_location("ftth_auth", AUTH_PY)
auth = importlib.util.module_from_spec(spec)
sys.modules["ftth_auth"] = auth
spec.loader.exec_module(auth)


def puerto_libre():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class AuthTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = os.path.join(cls.tmp.name, "ftth.db")
        # Una base como la dejaba 0.7.x: sin la columna redes.
        c = sqlite3.connect(cls.db)
        c.execute("CREATE TABLE usuarios (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL UNIQUE, clave TEXT NOT NULL, creado TEXT NOT NULL)")
        c.execute("INSERT INTO usuarios (nombre, clave, creado) VALUES ('vieja', ?, '2026-10-13T00:00:00Z')",
                  (auth.hash_password("clave-vieja-123"),))
        c.commit()
        c.close()
        auth.Handler.store = auth.Store(cls.db)
        auth.Handler.throttle = auth.Throttle()
        auth.Handler.store.add_user("admin", "clave-admin-123")
        auth.Handler.store.add_user("tecnico", "clave-tecnico-1", [3, 1])
        auth.Handler.store.add_user("nadie", "clave-nadie-123", [])
        cls.port = puerto_libre()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", cls.port), auth.Handler)
        cls.httpd.daemon_threads = True
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        auth.Handler.store.close()
        cls.tmp.cleanup()

    def sesion(self, usuario, clave):
        """Entra y devuelve un abridor con la cookie de sesión."""
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/auth/login", data=json.dumps({"usuario": usuario, "clave": clave}).encode(),
                                     headers={"Content-Type": "application/json", "Host": "traza.ejemplo"}, method="POST")
        with opener.open(req, timeout=5) as res:
            self.assertEqual(res.status, 200)
        return opener

    def pedir(self, opener, ruta):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{ruta}", headers={"Host": "traza.ejemplo"})
        try:
            with opener.open(req, timeout=5) as res:
                cuerpo = res.read()
                return res.status, dict(res.headers), json.loads(cuerpo) if cuerpo else None
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers), json.loads(err.read() or b"null")

    def test_migracion_y_quien_administra(self):
        # La columna se agregó y el usuario anterior administra.
        c = sqlite3.connect(self.db)
        columnas = {r[1] for r in c.execute("PRAGMA table_info(usuarios)")}
        c.close()
        self.assertIn("redes", columnas)
        estado, cab, dato = self.pedir(self.sesion("vieja", "clave-vieja-123"), "/auth/check")
        self.assertEqual((estado, cab["X-Usuario"], cab["X-Redes"]), (200, "vieja", "*"))
        estado, _, dato = self.pedir(self.sesion("admin", "clave-admin-123"), "/auth/session")
        self.assertEqual((estado, dato), (200, {"usuario": "admin", "administra": True, "redes": None}))

    def test_redes_del_usuario(self):
        tecnico = self.sesion("tecnico", "clave-tecnico-1")
        estado, cab, _ = self.pedir(tecnico, "/auth/check")
        self.assertEqual((estado, cab["X-Usuario"], cab["X-Redes"]), (200, "tecnico", "1,3"))
        estado, _, dato = self.pedir(tecnico, "/auth/session")
        self.assertEqual(dato, {"usuario": "tecnico", "administra": False, "redes": [1, 3]})
        estado, cab, _ = self.pedir(self.sesion("nadie", "clave-nadie-123"), "/auth/check")
        self.assertEqual(cab["X-Redes"], "-")
        # Cambiar las redes vale para las sesiones abiertas.
        auth.Handler.store.set_redes("tecnico", [2])
        self.assertEqual(self.pedir(tecnico, "/auth/check")[1]["X-Redes"], "2")
        auth.Handler.store.set_redes("tecnico", None)
        self.assertEqual(self.pedir(tecnico, "/auth/check")[1]["X-Redes"], "*")

    def test_sin_sesion(self):
        opener = urllib.request.build_opener()
        self.assertEqual(self.pedir(opener, "/auth/check")[0], 401)
        self.assertEqual(self.pedir(opener, "/auth/session")[0], 401)
        self.assertEqual(self.pedir(opener, "/auth/health")[2], {"ok": True})

    def test_redes_texto(self):
        self.assertIsNone(auth.redes_texto(None))
        self.assertEqual(auth.redes_texto([3, 1, 3]), "1,3")
        self.assertEqual(auth.redes_texto([]), "")
        self.assertEqual(auth.redes_lista("1,3"), [1, 3])
        self.assertEqual(auth.redes_lista(""), [])
        self.assertIsNone(auth.redes_lista(None))
        self.assertEqual((auth.redes_cabecera(None), auth.redes_cabecera([1, 3]), auth.redes_cabecera([])), ("*", "1,3", "-"))


if __name__ == "__main__":
    unittest.main()
