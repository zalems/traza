#!/usr/bin/env python3
"""Pruebas de las OLT que se cargan en traza y se leen directo (SNMP), de la
prueba de conexión y del chasis que entrega la API.

Levanta la API con una base temporal y, al lado, una OLT Huawei de mentira
(pruebas/olt_falsa.py: SNMP y Telnet en 127.0.0.1) y un panel falso.

  python3 -m unittest discover -s pruebas -v
"""

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from olt_falsa import OltFalsa, chasis_x17
from test_integraciones import Falso, puerto_libre

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API_PY = os.path.join(RAIZ, "api", "ftth-api.py")
spec = importlib.util.spec_from_file_location("ftth_api_olt", API_PY)
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

COMUNIDAD = "lectura-de-prueba"
CLAVE = "Clave-de-la-olt"


class OltDirectaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = os.path.join(cls.tmp.name, "red.db")
        cls.config = os.path.join(cls.tmp.name, "integraciones.json")
        api.Handler.store = api.Store(cls.db)
        api.Handler.integraciones = api.Integraciones(cls.config)
        api.Handler.historia = api.HistoriaOlt(os.path.join(cls.tmp.name, "olt.db"))
        api.Handler.secreto = ""
        cls.port = puerto_libre()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", cls.port), api.Handler)
        cls.httpd.daemon_threads = True
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.olt = OltFalsa(api, community=COMUNIDAD, clave=CLAVE)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.olt.cerrar()
        api.Handler.historia.close()
        cls.tmp.cleanup()

    # ------------------------------------------------------------- ayudas

    def pedir(self, method, path, body=None, redes=None, crudo=False):
        h = {"Host": "traza.ejemplo", "X-Usuario": "ana"}
        if redes is not None:
            h["X-Redes"] = redes
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                texto = res.read()
                return res.status, texto.decode() if crudo else json.loads(texto or b"null")
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"null")

    def ok(self, method, path, body=None, status=200, **kw):
        code, data = self.pedir(method, path, body, **kw)
        self.assertEqual(code, status, data)
        return data

    def red(self, nombre):
        return self.ok("POST", "/api/redes", {"nombre": nombre}, status=201)["red"]["id"]

    def equipo(self, olt=None, **cambios):
        olt = olt or self.olt
        base = {"nombre": "OLT Centro", "host": "127.0.0.1", "modelo": "", "snmp_puerto": olt.puerto, "comunidad": COMUNIDAD,
                "consola": "telnet", "consola_puerto": olt.telnet, "usuario": "traza", "clave": CLAVE, "utc": -180}
        base.update(cambios)
        return base

    def cargar(self, red, olt=None, **cambios):
        return self.ok("POST", "/api/olt/equipos", {"red": red, "equipo": self.equipo(olt, **cambios)}, status=201)["id"]

    def leer(self, red):
        """Lo que hace el hilo lector, acá mismo."""
        api.Handler.integraciones.leer_directas([red], minimo=0)

    # ------------------------------------------------------------- pruebas

    def test_utilidades(self):
        self.assertEqual(api.puerto_de_nombre("GPON 0/18/3"), ("pon", 0, 18, 3))
        self.assertEqual(api.puerto_de_nombre("ethernet0/9/0"), ("eth", 0, 9, 0))
        self.assertEqual(api.puerto_de_nombre("XG-PON 0/2/7"), ("pon", 0, 2, 7))
        self.assertIsNone(api.puerto_de_nombre("vlanif100"))
        self.assertIsNone(api.puerto_de_nombre("meth0"))
        self.assertEqual(api.puerto_gpon(4194304000 + 18 * 8192 + 3 * 256), "0/18/3")
        self.assertEqual(api.rol_placa("H901GPHF"), "pon")
        self.assertEqual(api.rol_placa("H903MPLA"), "control")
        self.assertEqual(api.rol_placa("H901PILA"), "energia")
        self.assertEqual(api.rol_placa("H901CIUA"), "interfaz")
        self.assertEqual(api.estado_placa("Active_normal"), "normal")
        self.assertEqual(api.estado_placa("Failed"), "falla")
        # 2026-11-13 18:30:15 en el reloj de la OLT (UTC−3) son las 21:30:15 UTC.
        sin_zona = (2026).to_bytes(2, "big") + bytes([11, 13, 18, 30, 15, 0])
        self.assertEqual(api.fecha_snmp(sin_zona, -180), "2026-11-13T21:30:15Z")
        self.assertEqual(api.fecha_snmp(sin_zona + b"-" + bytes([3, 0]), 0), "2026-11-13T21:30:15Z")
        self.assertIsNone(api.fecha_snmp(bytes(8), -180))  # nunca cayó
        self.assertIsNone(api.fecha_snmp(b"x", -180))

        def placas(**roles):
            return [{"slot": s, "rol": r} for r, slots in roles.items() for s in slots]

        self.assertEqual(api.chasis_de("MA5800-X17", []), "X17")
        self.assertEqual(api.chasis_de("EA5800-X2", []), "X2")
        self.assertEqual(api.chasis_de(None, placas(control=[9], pon=[18, 19], energia=[20])), "X17")
        self.assertEqual(api.chasis_de(None, placas(control=[8, 9], pon=[1, 2, 15])), "X15")
        self.assertEqual(api.chasis_de(None, placas(control=[8, 9], pon=[1, 2], energia=[10])), "X7")
        self.assertEqual(api.chasis_de(None, placas(control=[3], pon=[1], energia=[0])), "X2")
        self.assertIsNone(api.chasis_de(None, placas(pon=[1, 2])))
        self.assertIsNone(api.chasis_de("otra cosa", []))

    def test_lectura_por_snmp(self):
        olt = OltFalsa(api, community="otra-comunidad")
        self.addCleanup(olt.cerrar)
        eq = api.equipo_de({"id": "abcdef01", "nombre": "Prueba", "host": "127.0.0.1",
                            "snmp": {"puerto": olt.puerto, "community": "otra-comunidad"}})
        uno = api.leer_huawei(eq)
        self.assertEqual(uno["sistema"]["nombre"], "OLT-DE-PRUEBA")
        self.assertEqual(len(uno["onts"]), 12)
        self.assertEqual({s: p["nombre"] for s, p in uno["placas"].items()},
                         {0: "H901PISB", 1: "H901GPHF", 2: "H902GPSF", 3: "H901MPSC", 4: "H901MPSC"})
        self.assertEqual(sum(1 for p in uno["puertos"].values() if p["tipo"] == "pon"), 32)  # y nada de vlanif ni meth
        self.assertEqual(sum(1 for p in uno["puertos"].values() if p["tipo"] == "eth"), 8)
        medidas = {m["sn"]: m for m in api.medidas_directas(uno, "Prueba")}
        m = medidas["HWTC00000065"]
        self.assertEqual((m["interfaz"], m["ont_id"], m["estado"], m["rx"], m["descripcion"], m["distancia"], m["fuente"]),
                         ("0/1/0", 0, "online", -18.5, "#101 Cliente 101", 800, "olt"))
        placas = {p["slot"]: p for p in api.placas_de_lectura(uno)}
        self.assertEqual(placas[1]["rol"], "pon")
        puerto = placas[1]["puertos"][0]
        self.assertEqual((puerto["clave"], puerto["interfaz"], puerto["estado"], puerto["tx"], puerto["entra"]),
                         ("pon:0/1/0", "0/1/0", "up", 3.2, None))  # el tráfico necesita dos lecturas
        self.assertEqual(placas[1]["puertos"][8]["estado"], "down")  # un puerto sin ONT
        self.assertEqual([p["estado"] for p in placas[3]["puertos"]], ["up", "ausente", "ausente", "ausente"])
        self.assertEqual(api.chasis_de(None, list(placas.values())), "X2")

        # Una lectura rápida: solo el estado; de quién es cada ONT y cuánto recibe quedan de la anterior.
        cuando = time.time() - 300
        olt.caer("HWTC00000066", causa=13, cuando=cuando)
        antes = olt.pedidos
        dos = api.leer_huawei(eq, uno, completa=False)
        self.assertLess(olt.pedidos - antes, 14)
        caida = {m["sn"]: m for m in api.medidas_directas(dos, "Prueba")}["HWTC00000066"]
        self.assertEqual((caida["estado"], caida["causa"], caida["rx"], caida["descripcion"]),
                         ("offline", "dying-gasp", -19.6, "#102 Cliente 102"))
        self.assertAlmostEqual(api.momento(caida["ultima_caida"]), cuando, delta=2)
        self.assertEqual(api.tipo_causa(caida["causa"]), "energia")
        # Aparece una ONT: aunque la lectura sea rápida, se lee de quién es.
        olt.agregar(5, 999, "#999 Nueva")
        tres = api.leer_huawei(eq, dos, completa=False)
        self.assertIn("HWTC000003E7", {m["sn"] for m in api.medidas_directas(tres, "Prueba")})
        # Con otra comunidad, la OLT no contesta.
        mala = api.equipo_de({"id": "abcdef02", "host": "127.0.0.1", "snmp": {"puerto": olt.puerto, "community": "x"}})
        with self.assertRaises(api.IntegracionError) as ctx:
            with api.Snmp(mala["host"], mala["snmp"]["puerto"], "x", espera=0.3) as s:
                s.get([api.SYS_NOMBRE])
        self.assertEqual(str(ctx.exception), "no respondió por SNMP")

    def test_cargar_una_olt(self):
        red = self.red("Carga")
        # Solo quien administra: acá entran la comunidad y la clave.
        code, data = self.pedir("POST", "/api/olt/equipos", {"red": red, "equipo": self.equipo()}, redes=str(red))
        self.assertEqual(code, 403, data)
        code, _ = self.pedir("POST", "/api/olt/equipos/probar", {"red": red, "equipo": self.equipo()}, redes=str(red))
        self.assertEqual(code, 403)
        for mal, falta in (({"host": ""}, "dirección"), ({"host": "http://10.0.0.1"}, "dirección"), ({"host": "10.0.0.1 x"}, "dirección"),
                           ({"nombre": ""}, "nombre"), ({"snmp_puerto": 70000}, "puerto"), ({"modelo": "ZX-1"}, "modelo"),
                           ({"consola": "rsh"}, "consola"), ({"utc": "tres"}, "hora"), ({"comunidad": "a\nb"}, "comunidad")):
            code, data = self.pedir("POST", "/api/olt/equipos", {"red": red, "equipo": self.equipo(**mal)})
            self.assertEqual(code, 400, mal)
            self.assertIn(falta, data["error"].lower(), mal)
        eq_id = self.cargar(red)
        code, data = self.pedir("POST", "/api/olt/equipos", {"red": red, "equipo": self.equipo(nombre="olt centro")})
        self.assertEqual(code, 400)
        self.assertIn("ya hay una olt con ese nombre", data["error"].lower())
        # El archivo queda solo para el servicio, con la comunidad y la clave adentro.
        self.assertEqual(stat.S_IMODE(os.stat(self.config).st_mode), 0o600)
        guardado = api.leer_config(self.config)["redes"][str(red)]["olts"][0]
        self.assertEqual((guardado["snmp"]["community"], guardado["consola"]["clave"]), (COMUNIDAD, CLAVE))
        # Y no vuelven a salir: ni para quien administra.
        code, texto = self.pedir("GET", f"/api/olt?red={red}", crudo=True)
        self.assertEqual(code, 200)
        self.assertNotIn(COMUNIDAD, texto)
        self.assertNotIn(CLAVE, texto)
        equipos = json.loads(texto)["equipos"]
        self.assertEqual(len(equipos), 1)
        self.assertEqual(equipos[0]["conexion"], {
            "host": "127.0.0.1", "modelo": "", "snmp_puerto": self.olt.puerto, "tiene_comunidad": True, "consola": "telnet",
            "consola_puerto": self.olt.telnet, "usuario": "traza", "tiene_clave": True, "utc": -180, "leer": True, "panel": None})
        # Quien no administra ve la OLT, no cómo se llega a ella.
        otro = self.ok("GET", f"/api/olt?red={red}", redes=str(red))
        self.assertFalse(otro["administra"])
        self.assertNotIn("conexion", otro["equipos"][0])
        # Cambiarla sin escribir la comunidad ni la clave las conserva; con otro usuario, la clave vieja no sirve más.
        self.ok("PUT", f"/api/olt/equipos/{eq_id}", {"red": red, "equipo": self.equipo(nombre="OLT Sur", comunidad="", clave="")})
        guardado = api.leer_config(self.config)["redes"][str(red)]["olts"][0]
        self.assertEqual((guardado["nombre"], guardado["snmp"]["community"], guardado["consola"]["clave"]), ("OLT Sur", COMUNIDAD, CLAVE))
        self.ok("PUT", f"/api/olt/equipos/{eq_id}", {"red": red, "equipo": self.equipo(usuario="otro", comunidad="nueva", clave="")})
        guardado = api.leer_config(self.config)["redes"][str(red)]["olts"][0]
        self.assertEqual((guardado["snmp"]["community"], guardado["consola"]["usuario"], guardado["consola"]["clave"]),
                         ("nueva", "otro", ""))
        code, _ = self.pedir("PUT", "/api/olt/equipos/ffffffff", {"red": red, "equipo": self.equipo()})
        self.assertEqual(code, 404)
        # En otra red no se toca.
        otra = self.red("Carga B")
        code, _ = self.pedir("DELETE", f"/api/olt/equipos/{eq_id}?red={otra}")
        self.assertEqual(code, 404)
        self.ok("DELETE", f"/api/olt/equipos/{eq_id}?red={red}")
        self.assertEqual(self.ok("GET", f"/api/olt?red={red}")["equipos"], [])
        self.assertNotIn(str(red), api.leer_config(self.config)["redes"])

    def test_probar_la_conexion(self):
        red = self.red("Prueba de conexión")
        data = self.ok("POST", "/api/olt/equipos/probar", {"red": red, "equipo": self.equipo()})
        snmp, consola = data["pruebas"]
        self.assertTrue(snmp["ok"], snmp)
        self.assertEqual(snmp["titulo"], f"Lectura por SNMP (UDP {self.olt.puerto})")
        datos = dict(snmp["datos"])
        self.assertEqual(datos["Nombre"], "OLT-DE-PRUEBA")
        self.assertEqual(datos["Puertos PON"], "32")
        self.assertEqual(datos["ONT"], "12 (12 en línea)")
        self.assertIn("H901GPHF en 1", datos["Placas"])
        self.assertIn("3,2 dBm en 0/1/0", datos["Potencia que emiten los puertos"])
        self.assertEqual(data["detectado"], {"nombre": "OLT-DE-PRUEBA", "modelo": "MA5800-X2"})
        self.assertTrue(consola["ok"], consola)
        self.assertIn("Entró con el usuario «traza»", consola["texto"])
        antes = self.olt.sesiones
        # Con la comunidad y la clave equivocadas: dice qué revisar, y no entra.
        data = self.ok("POST", "/api/olt/equipos/probar", {"red": red, "equipo": self.equipo(comunidad="otra", clave="mala")})
        snmp, consola = data["pruebas"]
        self.assertFalse(snmp["ok"])
        self.assertEqual(snmp["texto"], "La OLT no respondió por SNMP.")
        self.assertEqual(len(snmp["pistas"]), 3)
        self.assertIn("127.0.0.1", snmp["pistas"][1])
        self.assertFalse(consola["ok"])
        self.assertEqual(consola["texto"], "La OLT no aceptó el usuario o la clave.")
        self.assertEqual(self.olt.sesiones, antes)
        # Sin consola, se prueba solo la lectura; sin usuario, solo que el puerto responda.
        data = self.ok("POST", "/api/olt/equipos/probar", {"red": red, "equipo": self.equipo(consola="")})
        self.assertEqual([p["que"] for p in data["pruebas"]], ["snmp"])
        data = self.ok("POST", "/api/olt/equipos/probar", {"red": red, "equipo": self.equipo(usuario="", clave="")})
        self.assertTrue(data["pruebas"][1]["ok"])
        self.assertTrue(data["pruebas"][1]["parcial"])
        # Un puerto donde no hay nada.
        libre = puerto_libre()
        data = self.ok("POST", "/api/olt/equipos/probar", {"red": red, "equipo": self.equipo(consola_puerto=libre, snmp_puerto=libre)})
        self.assertFalse(data["pruebas"][0]["ok"])
        self.assertIn("rechazó", data["pruebas"][1]["texto"])
        self.assertTrue(data["pruebas"][1]["pistas"])
        # De una OLT ya cargada, la prueba usa lo guardado si no se escribe de nuevo.
        eq_id = self.cargar(red)
        data = self.ok("POST", "/api/olt/equipos/probar", {"red": red, "id": eq_id, "equipo": self.equipo(comunidad="", clave="")})
        self.assertTrue(data["pruebas"][0]["ok"])
        self.assertTrue(data["pruebas"][1]["ok"])
        self.assertNotIn(COMUNIDAD, json.dumps(data))
        self.assertNotIn(CLAVE, json.dumps(data))

    def test_tablero_de_una_olt_directa(self):
        olt = OltFalsa(api, community=COMUNIDAD)
        self.addCleanup(olt.cerrar)
        red = self.red("Directa")
        self.assertEqual(self.ok("GET", f"/api/integracion?red={red}"), {"wispro": False, "panel": False})
        eq_id = self.cargar(red, olt, consola="")
        self.assertEqual(self.ok("GET", f"/api/integracion?red={red}"), {"wispro": False, "panel": True})
        # Recién cargada: todavía no se leyó.
        data = self.ok("GET", f"/api/olt?red={red}")
        self.assertEqual(data["errores"], ["OLT Centro: se está leyendo por primera vez."])
        self.assertEqual(data["onts"], [])
        self.leer(red)
        data = self.ok("GET", f"/api/olt?red={red}")
        self.assertEqual(data["errores"], [])
        self.assertEqual(data["olts"], ["OLT Centro"])
        r = data["resumen"]
        self.assertEqual((r["onts"], r["en_linea"], r["caidas"]), (12, 12, 0))
        self.assertEqual([p["interfaz"] for p in data["pon"]], ["0/1/0", "0/1/1", "0/1/2", "0/1/3"])
        self.assertEqual(data["pon"][0]["tx"], 3.2)
        ont = data["onts"][0]
        self.assertEqual((ont["panel_id"], ont["sn"], ont["interfaz"], ont["rx"], ont["nivel"], ont["distancia"]),
                         (None, "HWTC00000065", "0/1/0", -18.5, "bien", 800))
        (equipo,) = data["equipos"]
        self.assertEqual((equipo["id"], equipo["origen"], equipo["chasis"], equipo["registrado"], equipo["error"]),
                         (eq_id, "directa", "X2", True, None))
        self.assertEqual([(p["slot"], p["nombre"], p["rol"], len(p["puertos"])) for p in equipo["placas"]],
                         [(0, "H901PISB", "energia", 0), (1, "H901GPHF", "pon", 16), (2, "H902GPSF", "pon", 16),
                          (3, "H901MPSC", "control", 4), (4, "H901MPSC", "control", 4)])
        # Un cliente del mapa con esa ONT anotada: la señal lo encuentra.
        cliente = self.ok("POST", "/api/elementos", {"red": red, "tipo": "cliente", "nombre": "Ana", "lon": -58.17, "lat": -26.17,
                                                     "datos": {"ont": "HWTC00000065"}}, status=201)["elemento"]
        estados = self.ok("GET", f"/api/integracion/estados?red={red}")
        self.assertEqual(estados["clientes"][str(cliente["id"])]["rx"], -18.5)
        # Tres ONT de un puerto se quedan sin luz: novedad, con las ONT por su número de serie.
        historia = api.Handler.historia
        for sn in ("HWTC00000065", "HWTC00000066", "HWTC00000067"):
            olt.caer(sn, causa=2)
        time.sleep(1.1)  # otra lectura, otro instante
        self.leer(red)
        data = self.ok("GET", f"/api/olt?red={red}")
        self.assertEqual(data["resumen"]["caidas"], 3)
        novedad = next(n for n in data["novedades"] if n["tipo"] == "pon-caido")
        self.assertEqual((novedad["interfaz"], novedad["motivo"], novedad["onts"], sorted(novedad["sns"])),
                         ("0/1/0", "fibra", [], ["HWTC00000065", "HWTC00000066", "HWTC00000067"]))
        # La historia de una ONT leída directo sale de lo que traza anotó.
        t = int(time.time())
        c = historia.conn()
        c.executemany("INSERT INTO lecturas (red, sn, t, rx) VALUES (?, ?, ?, ?)",
                      [(red, "HWTC00000068", t - t % 900 - 900 * i, -20.0 - i * 0.01) for i in range(1, 300)])
        c.execute("INSERT INTO eventos (red, t, sn, olt, pon, tipo, causa) VALUES (?, ?, 'HWTC00000068', 'OLT Centro', '0/1/1', 'cae', 'LOSi/LOBi')",
                  (red, t - 7200))
        serie = self.ok("GET", f"/api/olt/ont?red={red}&sn=HWTC00000068&horas=168")
        self.assertGreater(len(serie["puntos"]), 40)
        self.assertEqual(serie["eventos"], [{"cuando": api.iso_de(t - 7200), "tipo": "offline", "causa": "LOSi/LOBi"}])
        self.assertAlmostEqual(serie["tendencia"]["db_semana"], 6.72, delta=0.3)  # 0,01 dB cada 15 minutos
        code, _ = self.pedir("GET", f"/api/olt/ont?red={red}&sn=HWTC99999999")
        self.assertEqual(code, 404)
        otra = self.red("Directa B")
        code, _ = self.pedir("GET", f"/api/olt/ont?red={otra}&sn=HWTC00000068")
        self.assertEqual(code, 404)
        # El tráfico de cada puerto queda anotado (hace falta una segunda lectura para saber el ritmo).
        time.sleep(5.2)
        self.leer(red)
        dp = api.Handler.integraciones.datos_panel(red)[0]
        historia.anotar(red, dp)
        trafico = self.ok("GET", f"/api/olt/trafico?red={red}&olt=OLT%20Centro&puerto=pon:0/1/1&horas=24")
        (punto,) = trafico["puntos"]
        self.assertAlmostEqual(punto["sale"], 120e6, delta=6e6)  # tres ONT a 40 Mb/s
        self.assertAlmostEqual(punto["entra"], 12e6, delta=1e6)
        code, _ = self.pedir("GET", f"/api/olt/trafico?red={red}&olt=x&puerto=../../etc")
        self.assertEqual(code, 400)
        # La OLT deja de contestar: queda lo último leído, con el aviso.
        olt.muda = True
        api.Handler.integraciones.leer_directas([red], minimo=0)
        data = self.ok("GET", f"/api/olt?red={red}")
        self.assertEqual(len(data["errores"]), 1)
        self.assertRegex(data["errores"][0], r"^OLT Centro: no respondió por SNMP; se muestra lo leído ")
        self.assertEqual(data["resumen"]["onts"], 12)
        self.assertEqual(data["equipos"][0]["error"], "no respondió por SNMP")
        # En pausa: no se lee más y la red queda sin OLT de dónde leer.
        self.ok("PUT", f"/api/olt/equipos/{eq_id}", {"red": red, "equipo": self.equipo(olt, consola="", leer=False)})
        data = self.ok("GET", f"/api/olt?red={red}")
        self.assertEqual(data["configurada"]["panel"], False)
        self.assertEqual(data["equipos"][0]["error"], "no se lee: está en pausa")

    def test_olt_del_panel_con_su_chasis(self):
        panel = Falso("panel")
        self.addCleanup(panel.cerrar)
        olt = OltFalsa(api, community=COMUNIDAD, placas=chasis_x17(), puertos_con_onts=0)
        self.addCleanup(olt.cerrar)
        p = panel.rutas
        p["/api/olts"] = lambda q, h: (200, [
            {"id": 1, "name": "ALVATIC-MA5800-01", "model": "MA5800-X17", "firmware": "V100R019", "host": "10.10.0.2",
             "last_poll_at": api.now_iso(), "last_error": None},
            {"id": 9, "name": "DE-OTRA-EMPRESA", "model": "MA5800-X7", "host": "10.9.9.9"}])
        p["/api/olts/1/onts"] = lambda q, h: (200, [] if int(q.get("offset", ["0"])[0]) else [
            {"id": 5, "slot": 18, "port": 0, "ont_id": 0, "sn": "4857544390BCF28A", "description": "#391 Gómez Ana",
             "run_state": "online", "rx_power_dbm": "-21.30", "last_seen": api.now_iso(), "distance_m": 1234}])
        p["/api/thresholds"] = lambda q, h: (200, {"gpon": {"warn": -25.0, "crit": -28.0, "high": -8.0}})
        p["/api/olts/1/chassis"] = lambda q, h: (200, {"olt_id": 1, "boards": (
            [{"slot_id": s, "board_name": None, "status": None, "role": None, "ports": []} for s in range(0, 9)]
            + [{"slot_id": 9, "board_name": "H903MPLA", "status": "Active_normal", "role": "control", "technology": None, "ports": []},
               {"slot_id": 10, "board_name": None, "status": None, "role": None, "ports": []},
               {"slot_id": 18, "board_name": "H901GPHF", "status": "Normal", "role": "pon", "technology": "gpon",
                "ports": [{"slot": 18, "port": n, "total": 1 if n == 0 else 0, "online": 1 if n == 0 else 0, "critical": 0, "warning": 0}
                          for n in range(16)]},
               {"slot_id": 20, "board_name": "H901PILA", "status": "Normal", "role": "power", "ports": []}])})
        p["/api/olts/1/interfaces"] = lambda q, h: (200, [
            {"id": 40, "if_index": 234954816, "if_name": "ethernet0/9/0", "slot": 9, "port": 0, "speed_mbps": 10000,
             "oper_status": "up", "is_uplink": True, "in_bps": 909000000.0, "out_bps": 54000000.0},
            {"id": 41, "if_index": 234954880, "if_name": "ethernet0/9/1", "slot": 9, "port": 1, "speed_mbps": 0,
             "oper_status": "notPresent", "is_uplink": True, "in_bps": None, "out_bps": None},
            # El slot 10 (la placa de control de reserva) está vacío, pero la OLT lista igual sus puertos.
            {"id": 44, "if_index": 234963008, "if_name": "ethernet0/10/0", "slot": 10, "port": 0, "speed_mbps": 0,
             "oper_status": "notPresent", "is_uplink": True, "in_bps": None, "out_bps": None},
            {"id": 50, "if_index": 4194451456, "if_name": "GPON 0/18/0", "slot": 18, "port": 0, "speed_mbps": 2500,
             "oper_status": "up", "is_uplink": False, "in_bps": 9500000.0, "out_bps": 172000000.0}])
        red = self.red("Con panel")
        data = api.leer_config(self.config)
        data["redes"].setdefault(str(red), {})["panel"] = {"url": panel.url, "olts": [1]}
        api.guardar_config(self.config, data)
        os.utime(self.config, ns=(time.time_ns(), time.time_ns() + 1))
        data = self.ok("GET", f"/api/olt?red={red}")
        self.assertEqual(data["errores"], [])
        (equipo,) = data["equipos"]  # la OLT de la otra empresa no aparece
        self.assertEqual((equipo["id"], equipo["nombre"], equipo["origen"], equipo["modelo"], equipo["chasis"], equipo["registrado"],
                          equipo["host_panel"]), ("p1", "ALVATIC-MA5800-01", "panel", "MA5800-X17", "X17", False, "10.10.0.2"))
        placas = {x["slot"]: x for x in equipo["placas"]}
        self.assertEqual(sorted(placas), [9, 18, 20])  # los slots vacíos no van
        self.assertEqual((placas[9]["rol"], placas[9]["estado"], placas[9]["detalle"]), ("control", "normal", "Active_normal"))
        self.assertEqual(placas[20]["rol"], "energia")
        subida = placas[9]["puertos"][0]
        self.assertEqual((subida["clave"], subida["estado"], subida["entra"], subida["uplink"]), ("eth:0/9/0", "up", 909000000.0, True))
        self.assertEqual(placas[9]["puertos"][1]["estado"], "ausente")
        self.assertEqual(len(placas[18]["puertos"]), 16)
        self.assertEqual((placas[18]["puertos"][0]["sale"], placas[18]["puertos"][1]["estado"]), (172000000.0, None))
        self.assertEqual((data["pon"][0]["sale"], data["pon"][0]["entra"], data["pon"][0]["tx"]), (172000000.0, 9500000.0, None))
        self.assertEqual(data["onts"][0]["distancia"], 1234.0)
        self.assertNotIn("host_panel", self.ok("GET", f"/api/olt?red={red}", redes=str(red))["equipos"][0])
        # Se le carga la conexión a esa OLT: sus ONT siguen saliendo del panel y de la OLT se lee lo que el panel no da.
        code, data = self.pedir("POST", "/api/olt/equipos", {"red": red, "equipo": self.equipo(olt, consola="", panel=9)})
        self.assertEqual(code, 400)  # la 9 es de otra empresa
        eq_id = self.cargar(red, olt, consola="", panel=1, nombre="")
        self.leer(red)
        data = self.ok("GET", f"/api/olt?red={red}")
        self.assertEqual(data["errores"], [])
        self.assertEqual(data["resumen"]["onts"], 1)
        (equipo,) = data["equipos"]
        self.assertEqual((equipo["id"], equipo["nombre"], equipo["origen"], equipo["registrado"], equipo["conexion"]["panel"]),
                         (eq_id, "ALVATIC-MA5800-01", "panel", True, 1))
        placas = {x["slot"]: x for x in equipo["placas"]}
        self.assertEqual(placas[18]["puertos"][3]["tx"], 3.41)  # de la OLT, por SNMP
        self.assertEqual(data["pon"][0]["tx"], 3.2)
        # El historial anota el tráfico de los puertos, también el de subida.
        historia = api.Handler.historia
        historia.anotar(red, api.Handler.integraciones.datos_panel(red)[0])
        trafico = self.ok("GET", f"/api/olt/trafico?red={red}&olt=ALVATIC-MA5800-01&puerto=eth:0/9/0&horas=24")
        self.assertEqual([(x["entra"], x["sale"]) for x in trafico["puntos"]], [(909000000, 54000000)])
        # Si el panel dice que no puede leer la OLT, se ve.
        p["/api/olts"] = lambda q, h: (200, [{"id": 1, "name": "ALVATIC-MA5800-01", "model": "MA5800-X17",
                                             "last_poll_at": "2026-07-01T10:00:00Z", "last_error": "SNMP timeout",
                                             "last_error_at": api.now_iso()}])
        api.Handler.integraciones.olvidar(("panel", red))
        data = self.ok("GET", f"/api/olt?red={red}")
        self.assertEqual(data["equipos"][0]["error"], "el panel no puede leerla: SNMP timeout")

    def test_comando_ver(self):
        red = self.red("Comando")
        self.cargar(red)
        r = subprocess.run([sys.executable, API_PY, "--db", self.db, "integraciones", "ver"], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"OLT «OLT Centro»: 127.0.0.1 (SNMP en el puerto {self.olt.puerto}; consola por telnet en el {self.olt.telnet})", r.stdout)
        self.assertNotIn(COMUNIDAD, r.stdout)
        self.assertNotIn(CLAVE, r.stdout)
        r = subprocess.run([sys.executable, API_PY, "--db", self.db, "integraciones", "probar", "Comando"],
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("OLT: 12 ONTs de OLT Centro", r.stdout)


if __name__ == "__main__":
    unittest.main()
