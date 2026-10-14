#!/usr/bin/env python3
"""Pruebas de las integraciones con Wispro y con el panel de la OLT.

Levanta la API con una base temporal y, al lado, un Wispro y un panel falsos
que responden como los reales (Wispro: 200 con el estado en el cuerpo y
colecciones paginadas; panel: listas y ONTs con el número de contrato al
principio de la descripción).

  python3 -m unittest discover -s pruebas -v
"""

import importlib.util
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API_PY = os.path.join(RAIZ, "api", "ftth-api.py")
spec = importlib.util.spec_from_file_location("ftth_api_integ", API_PY)
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

TOKEN = "token-bueno-123"
U = "00000000-0000-4000-8000-{:012d}".format  # UUID de prueba


def puerto_libre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Falso:
    """Un servidor que responde lo que se le cargue y cuenta los pedidos."""

    def __init__(self, nombre):
        self.nombre = nombre
        self.rutas = {}
        self.pedidos = []
        self.caido = False
        falso = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                u = urlsplit(self.path)
                falso.pedidos.append(u.path)
                if falso.caido:
                    self.send_response(503)
                    self.end_headers()
                    return
                fn = falso.rutas.get(u.path)
                extra = {}
                if fn is None:
                    status, body = 404, {"detail": "Not Found"}
                else:
                    status, body, *resto = fn(parse_qs(u.query), self.headers)
                    extra = resto[0] if resto else {}
                data = json.dumps(body).encode()
                self.send_response(status)
                for k, v in extra.items():
                    self.send_header(k, v)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.port = puerto_libre()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.port}"

    def cerrar(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def contar(self, ruta):
        return sum(1 for p in self.pedidos if p == ruta)


# ----------------------------------------------------------- datos de Wispro

NAPS = [
    {"id": U(1), "public_id": 1, "name": "P5C4", "details": None, "capacity": 16, "olt_id": U(900), "fbp": "0/0/1",
     "contracts_count": 5, "latitude": "-26.1800", "longitude": "-58.1660"},
    {"id": U(2), "public_id": 2, "name": "P5C5", "capacity": 16, "olt_id": U(900), "fbp": "0/0/1",
     "contracts_count": 1, "latitude": "-26.1810", "longitude": "-58.1670"},
    {"id": U(3), "public_id": 3, "name": "P9C1", "capacity": 16, "olt_id": U(901), "fbp": "0/19/3",
     "contracts_count": 0, "latitude": "-26.1900", "longitude": "-58.1800"},
]
CLIENTES = [
    {"id": U(101), "public_id": 120, "name": "Gómez, Ana", "latitude": "-26.1795", "longitude": "-58.1655"},
    {"id": U(102), "public_id": 121, "name": "Pereyra Luis Alberto", "latitude": None, "longitude": None},
    {"id": U(103), "public_id": 122, "name": "Candia Carmen"},
    {"id": U(104), "public_id": 123, "name": "Rodas Ramona"},
    {"id": U(105), "public_id": 124, "name": "Sin Ubicación"},
    {"id": U(106), "public_id": 125, "name": "Otra Caja"},
]


def contrato(n, cliente, nap, sn=None, lat=None, lon=None, estado="enabled", numero=None):
    return {"id": U(200 + n), "public_id": numero or 390 + n, "client_id": U(100 + cliente), "state": estado,
            "nap_id": U(nap), "nap_name": "x", "ont_serial_number": sn, "interface_gpon": None, "ont_number": None,
            "latitude": lat, "longitude": lon, "address_street": "San Martín", "address_number": str(100 + n),
            "olt_id": U(900), "pppoe_password": "secreto"}


CONTRATOS = [
    contrato(1, 1, 1, sn="HWTC90BCF28A", lat="-26.1795", lon="-58.1655"),      # por la ONT (hex en el panel)
    contrato(2, 2, 1, sn="HWTCD87F4EB6", lat="-26.1796", lon="-58.1658"),      # por el nombre
    contrato(3, 3, 1, sn=None, lat="-26.1797", lon="-58.1661", numero=405),    # sin serie: por #405 en el panel
    contrato(4, 4, 1, sn="HWTC00000001", lat="-26.1798", lon="-58.1662", estado="disabled"),  # no está en traza
    contrato(5, 5, 1, sn=None, lat=None, lon=None),                            # sin ubicación
    contrato(6, 6, 2, sn="HWTC00000002", lat="-26.1811", lon="-58.1671"),      # de otra caja
]

ONTS = [
    {"id": 5, "slot": 19, "port": 3, "ont_id": 0, "sn": "4857544390BCF28A", "description": "#391 Gómez Ana",
     "run_state": "online", "rx_power_dbm": "-21.30", "tx_power_dbm": "2.33", "last_seen": "2026-10-14T13:00:00Z",
     "rx_status": "ok", "technology": "gpon"},
    {"id": 6, "slot": 19, "port": 3, "ont_id": 1, "sn": "48575443D87F4EB6", "description": "#392 Pereyra Luis",
     "run_state": "online", "rx_power_dbm": "-25.53", "tx_power_dbm": "2.32", "last_seen": "2026-10-14T13:00:00Z",
     "rx_status": "warning"},
    {"id": 7, "slot": 19, "port": 3, "ont_id": 2, "sn": "48575443AAAAAAAA", "description": "#405 Candia Carmen",
     "run_state": "offline", "rx_power_dbm": None, "last_seen": "2026-10-13T22:00:00Z",
     "last_down_time": "2026-10-13T22:00:00Z", "last_down_cause": "LOS"},
]


class IntegracionesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = os.path.join(cls.tmp.name, "red.db")
        cls.config = os.path.join(cls.tmp.name, "integraciones.json")
        api.Handler.store = api.Store(cls.db)
        api.Handler.integraciones = api.Integraciones(cls.config)
        api.Handler.secreto = ""
        cls.port = puerto_libre()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", cls.port), api.Handler)
        cls.httpd.daemon_threads = True
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.wispro = Falso("wispro")
        cls.panel = Falso("panel")
        cls.cargar_falsos()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.wispro.cerrar()
        cls.panel.cerrar()
        cls.tmp.cleanup()

    @classmethod
    def cargar_falsos(cls):
        def coleccion(items, objeto, pagina_de=1000):
            def fn(q, headers):
                if headers.get("Authorization") != TOKEN:
                    return 200, {"status": 401, "meta": {}, "message": "Unauthorized", "errors": {}}
                pagina = int(q.get("page", ["1"])[0])
                por = min(int(q.get("per_page", ["20"])[0]), pagina_de)
                total = max(1, -(-len(items) // por))
                parte = items[(pagina - 1) * por:pagina * por]
                return 200, {"status": 200, "meta": {"object": objeto, "pagination": {
                    "total_records": len(items), "total_pages": total, "per_page": por, "current_page": pagina}},
                    "data": parte}
            return fn

        w = cls.wispro.rutas
        w["/naps"] = coleccion(NAPS, "nap")
        w["/contracts"] = coleccion(CONTRATOS, "contract", pagina_de=4)  # fuerza varias páginas
        w["/clients"] = coleccion(CLIENTES, "client")
        w["/olts"] = coleccion([{"id": U(900), "name": "OLT - CENTRAL"}, {"id": U(901), "name": "HUAWEI"}], "olt")
        w[f"/contracts/{U(201)}/status_ont"] = lambda q, h: (200, {"olt": {
            "ont_interface": "0/19/3:0", "serial_number": "4857544390BCF28A", "rx_power": "-20.10", "tx_power": "2.27",
            "temperature": "47", "status_rx_power": "ok"}})
        w[f"/contracts/{U(202)}/status_ont"] = lambda q, h: (200, {"status": 400, "meta": {}, "message": "Invalid record",
                                                                  "errors": {"base": ["Ont no puede estar en blanco"]}})

        p = cls.panel.rutas
        p["/api/olts"] = lambda q, h: (200, [{"id": 1, "name": "ALVATIC-MA5800-01", "ont_count": 3},
                                             {"id": 1362, "name": "ONSYS-MA5800-01", "ont_count": 1}])

        def onts(q, h):
            offset = int(q.get("offset", ["0"])[0])
            return 200, ONTS[offset:offset + int(q.get("limit", ["500"])[0])]

        p["/api/olts/1/onts"] = onts
        p["/api/olts/1362/onts"] = lambda q, h: (200, [{"id": 99, "sn": "4857544390BCF28A", "description": "#391 Otra"}])
        for ont in ONTS:
            p[f"/api/onts/{ont['id']}/series"] = lambda q, h: (200, {"bucket_seconds": 2016, "points": [], "trend": {
                "samples": 40, "rx_db_per_week": -0.2, "rx_min": "-21.9", "rx_max": "-21.1", "rx_avg": "-21.4"}})
            p[f"/api/onts/{ont['id']}/events"] = lambda q, h: (200, [
                {"occurred_at": "2026-10-13T22:00:00Z", "event_type": "offline", "details": {"cause": "LOS"}},
                {"occurred_at": "2026-07-17T17:45:42Z", "event_type": "appeared", "details": {"fsp": "0/19/3"}}])
        p["/api/thresholds"] = lambda q, h: (200, {"gpon": {"warn": -25.0, "crit": -28.0, "high": -8.0}})

    # ------------------------------------------------------------- ayudas

    def pedir(self, method, path, body=None):
        h = {"Host": "traza.ejemplo", "X-Usuario": "ana"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return res.status, json.loads(res.read() or b"null")
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"null")

    def ok(self, method, path, body=None, status=200):
        code, data = self.pedir(method, path, body)
        self.assertEqual(code, status, data)
        return data

    def configurar(self, red, wispro=True, panel=True, token=TOKEN, olts=(1,)):
        data = api.leer_config(self.config)
        cfg = {}
        if wispro:
            cfg["wispro"] = {"token": token, "url": self.wispro.url}
        if panel:
            cfg["panel"] = {"url": self.panel.url, "olts": list(olts)}
        data["redes"][str(red)] = cfg
        api.guardar_config(self.config, data)
        # La API relee el archivo si cambió; en la misma décima de segundo podría no notarlo.
        os.utime(self.config, ns=(time.time_ns(), time.time_ns() + 1))

    def red_con_caja(self, nombre_red, nombre_nap="P5-C4"):
        red = self.ok("POST", "/api/redes", {"nombre": nombre_red}, status=201)["red"]["id"]
        nap = self.ok("POST", "/api/elementos", {"red": red, "tipo": "nap", "nombre": nombre_nap, "lon": -58.1661,
                                                 "lat": -26.1801}, status=201)["elemento"]
        return red, nap

    def cliente(self, red, nombre, lon, lat, **datos):
        return self.ok("POST", "/api/elementos", {"red": red, "tipo": "cliente", "nombre": nombre, "lon": lon, "lat": lat,
                                                  "datos": datos}, status=201)["elemento"]

    # ------------------------------------------------------------- pruebas

    def test_utilidades(self):
        self.assertEqual(api.sn_canonico("4857544390BCF28A"), "HWTC90BCF28A")
        self.assertEqual(api.sn_canonico("hwtc-90bcf28a"), "HWTC90BCF28A")
        self.assertEqual(api.sn_canonico("47504F4E008A5179"), "GPON008A5179")
        self.assertIsNone(api.sn_canonico(""))
        self.assertEqual(api.sns_en_texto("HG8145V5 · 48575443D87F4EB6"), ["HWTCD87F4EB6"])
        self.assertEqual(api.sns_en_texto("serie HWTC 90BCF28A"), ["HWTC90BCF28A"])
        self.assertEqual(api.numero_de_descripcion("#534 38.199.203.56 (Ramona Rodas)"), 534)
        self.assertIsNone(api.numero_de_descripcion("Gómez Ana"))
        self.assertEqual(api.clave_caja("nap-031"), api.clave_caja("NAP 31"))
        self.assertEqual(api.clave_caja("P5-C4"), "P5C4")
        self.assertNotEqual(api.clave_caja("NAP 1-2"), api.clave_caja("NAP12"))  # entre números el separador cuenta
        self.assertNotEqual(api.clave_caja("C 10-1"), api.clave_caja("C101"))
        self.assertTrue(api.mismo_nombre(api.palabras("Gómez, Ana"), api.palabras("ANA GOMEZ")))
        self.assertTrue(api.mismo_nombre(api.palabras("Pereyra Luis"), api.palabras("Pereyra Luis Alberto")))
        self.assertFalse(api.mismo_nombre(api.palabras("Pereyra Luis"), api.palabras("Pereyra Marta")))
        self.assertEqual(api.interfaz_pon("0/19/3:5"), "0/19/3")
        self.assertIsNone(api.interfaz_pon("19/3"))
        self.assertIsNone(api.ubicacion("0", "0"))
        self.assertIsNone(api.ubicacion("", "-58"))
        self.assertEqual(api.ubicacion("-26.18", "-58.16"), [-58.16, -26.18])
        self.assertIsNone(api.numero("-"))
        self.assertIsNone(api.numero("NaN"))
        self.assertEqual(api.numero("-27,5"), -27.5)

    def test_sin_configurar(self):
        red, nap = self.red_con_caja("Sin integraciones")
        self.assertEqual(self.ok("GET", f"/api/integracion?red={red}"), {"wispro": False, "panel": False})
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        self.assertEqual(data["configurada"], {"wispro": False, "panel": False})
        self.assertNotIn("contratos", data)
        code, data = self.pedir("POST", "/api/integracion/nap/medir", {"elemento": nap["id"]})
        self.assertEqual(code, 409)
        # Un cliente no es una NAP.
        cli = self.cliente(red, "Alguien", -58.1, -26.1)
        self.assertEqual(self.pedir("GET", f"/api/integracion/nap?elemento={cli['id']}")[0], 400)
        self.assertEqual(self.pedir("GET", "/api/integracion/nap?elemento=999999")[0], 404)

    def test_caja_contratos_y_potencias(self):
        red, nap = self.red_con_caja("Con integraciones")
        self.configurar(red)
        # Clientes de traza: uno con la ONT anotada (en otra forma), uno con el mismo nombre
        # cerca, uno con el número de contrato y otro con el de cliente.
        a = self.cliente(red, "Ana", -58.17, -26.17, ont="HG8145V5 · 48575443-90BCF28A")
        b = self.cliente(red, "Luis Pereyra", -58.16585, -26.17962)
        c = self.cliente(red, "Carmen", -58.18, -26.18, contrato="#405")
        lejos = self.cliente(red, "Luis Pereyra", -58.20, -26.20)  # mismo nombre, lejos: no cuenta
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        self.assertEqual(data["errores"], [])
        self.assertEqual(data["nap"]["nombre"], "P5C4")
        self.assertEqual(data["nap"]["por"], "nombre")
        self.assertEqual(data["nap"]["olt"], "OLT - CENTRAL")
        self.assertEqual(data["nap"]["fbp"], "0/0/1")
        self.assertEqual(data["nap"]["contratos"], 5)
        por_id = {x["id"]: x for x in data["contratos"]}
        self.assertEqual(set(por_id), {U(201), U(202), U(203), U(204), U(205)})  # el de otra caja no
        uno = por_id[U(201)]
        self.assertEqual(uno["cliente"], "Gómez, Ana")
        self.assertEqual(uno["traza"], {"id": a["id"], "nombre": "Ana", "por": "ont"})
        self.assertEqual(uno["medida"]["rx"], -21.3)
        self.assertEqual(uno["medida"]["interfaz"], "0/19/3")
        self.assertEqual(uno["medida"]["olt"], "ALVATIC-MA5800-01")
        self.assertEqual(uno["historia"]["tendencia"]["rx_min"], -21.9)
        self.assertEqual(uno["historia"]["eventos"][0]["causa"], "LOS")
        self.assertNotIn("pppoe_password", json.dumps(data))
        self.assertEqual(por_id[U(202)]["traza"]["id"], b["id"])
        self.assertEqual(por_id[U(202)]["traza"]["por"], "nombre")
        self.assertNotEqual(por_id[U(202)]["traza"]["id"], lejos["id"])
        self.assertEqual(por_id[U(203)]["traza"]["por"], "contrato")
        self.assertEqual(por_id[U(203)]["traza"]["id"], c["id"])
        # Sin número de serie en Wispro: la ONT se encuentra por "#405" en la descripción.
        self.assertEqual(por_id[U(203)]["medida"]["estado"], "offline")
        self.assertEqual(por_id[U(203)]["medida"]["causa"], "LOS")
        self.assertIsNone(por_id[U(204)]["traza"])
        self.assertIsNone(por_id[U(204)]["medida"])  # su serie no está en el panel
        self.assertIsNone(por_id[U(205)]["ubicacion"])
        self.assertEqual(data["panel"]["onts"], 3)
        self.assertEqual(data["panel"]["olts"], ["ALVATIC-MA5800-01"])
        self.assertEqual(data["panel"]["leido"], "2026-10-14T13:00:00Z")
        # El cliente: su contrato, su ONT y su historia.
        dc = self.ok("GET", f"/api/integracion/cliente?elemento={a['id']}")
        self.assertEqual(dc["contrato"]["numero"], 391)
        self.assertEqual(dc["contrato"]["por"], "ont")
        self.assertEqual(dc["contrato"]["nap_nombre"], "P5C4")
        self.assertEqual(dc["medida"]["rx"], -21.3)
        self.assertEqual(dc["historia"]["tendencia"]["muestras"], 40)
        dl = self.ok("GET", f"/api/integracion/cliente?elemento={lejos['id']}")
        self.assertIsNone(dl["contrato"])

    def test_cache_y_refresco(self):
        red, nap = self.red_con_caja("Caché")
        self.configurar(red)
        antes = self.wispro.contar("/naps")
        self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        self.assertEqual(self.wispro.contar("/naps"), antes + 1)
        # "Actualizar" enseguida no vuelve a pedir (menos de REFRESCO_MINIMO).
        self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}&refrescar=1")
        self.assertEqual(self.wispro.contar("/naps"), antes + 1)
        # Varias páginas de contratos: se trajeron todas.
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        self.assertEqual(len(data["contratos"]), 5)

    def test_vincular_a_mano_y_candidatas(self):
        red, nap = self.red_con_caja("Vínculo", nombre_nap="NAP-031")
        self.configurar(red)
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        self.assertNotIn("nap", data)
        self.assertFalse(data["perdida"])
        nombres = [x["nombre"] for x in data["candidatas"]]
        self.assertEqual(nombres[:2], ["P5C4", "P5C5"])  # las más cercanas primero
        self.assertLess(data["candidatas"][0]["distancia_m"], 50)
        # Importar o medir sin vincular: 409.
        self.assertEqual(self.pedir("POST", "/api/integracion/nap/importar",
                                    {"elemento": nap["id"], "contratos": [U(204)]})[0], 409)
        props = nap["properties"]
        res = self.ok("PUT", f"/api/elementos/{nap['id']}", {"datos": {"wispro_nap": U(2), "wispro_nap_nombre": "P5C5"},
                                                            "version": props["version"]})
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        self.assertEqual(data["nap"]["nombre"], "P5C5")
        self.assertEqual(data["nap"]["por"], "vinculada")
        self.assertEqual([x["id"] for x in data["contratos"]], [U(206)])
        # La caja vinculada ya no está en Wispro: se avisa y se ofrecen otras.
        self.ok("PUT", f"/api/elementos/{nap['id']}", {"datos": {"wispro_nap": U(77)},
                                                       "version": res["elemento"]["properties"]["version"]})
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        self.assertTrue(data["perdida"])
        self.assertTrue(data["candidatas"])

    def test_importar(self):
        red, nap = self.red_con_caja("Importar")
        self.configurar(red)
        ids = [U(201), U(204), U(205), U(206)]
        res = self.ok("POST", "/api/integracion/nap/importar", {"elemento": nap["id"], "contratos": ids})
        self.assertEqual(len(res["elementos"]), 2)
        nuevos = {e["properties"]["nombre"]: e for e in res["elementos"]}
        ana = nuevos["Gómez, Ana"]["properties"]
        self.assertEqual(ana["estado"], "activo")
        self.assertEqual(ana["datos"]["wispro_contrato"], U(201))
        self.assertEqual(ana["datos"]["contrato"], "391")
        self.assertEqual(ana["datos"]["abonado"], "120")
        self.assertEqual(ana["datos"]["ont"], "HWTC90BCF28A")
        self.assertEqual(ana["datos"]["direccion"], "San Martín 101")
        self.assertEqual(ana["datos"]["nap_puerto"], "P5C4")
        self.assertEqual(nuevos["Rodas Ramona"]["properties"]["estado"], "instalado")  # contrato deshabilitado
        self.assertEqual(nuevos["Gómez, Ana"]["geometry"]["coordinates"], [-58.1655, -26.1795])
        motivos = {x["contrato"]: x["motivo"] for x in res["omitidos"]}
        self.assertEqual(motivos, {U(205): "no tiene ubicación en Wispro", U(206): "no es de esta caja en Wispro"})
        # Otra vez: ya están en el mapa (y la caja los muestra vinculados).
        res = self.ok("POST", "/api/integracion/nap/importar", {"elemento": nap["id"], "contratos": [U(201), U(204)]})
        self.assertEqual(res["elementos"], [])
        self.assertEqual({x["motivo"] for x in res["omitidos"]}, {"ya está en el mapa"})
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        por_id = {x["id"]: x for x in data["contratos"]}
        self.assertEqual(por_id[U(201)]["traza"]["por"], "vinculado")
        # Un cambio de otro usuario en la red llega a los demás por /api/cambios.
        cambios = self.ok("GET", f"/api/cambios?red={red}&desde=0")
        self.assertEqual(len([e for e in cambios["elementos"] if e["properties"]["tipo"] == "cliente"]), 2)
        # Validaciones.
        for body in ({"elemento": nap["id"], "contratos": []}, {"elemento": nap["id"], "contratos": ["nada"]},
                     {"elemento": nap["id"]}, {"elemento": nap["id"], "contratos": [U(1)] * 200}):
            self.assertEqual(self.pedir("POST", "/api/integracion/nap/importar", body)[0], 400, body)

    def test_medir_en_vivo(self):
        red, nap = self.red_con_caja("En vivo")
        self.configurar(red)
        res = self.ok("POST", "/api/integracion/nap/medir", {"elemento": nap["id"]})
        medidas = res["medidas"]
        # Solo los contratos con ONT en Wispro: 201, 202 y 204.
        self.assertEqual(set(medidas), {U(201), U(202), U(204)})
        self.assertEqual(medidas[U(201)]["rx"], -20.1)
        self.assertEqual(medidas[U(201)]["interfaz"], "0/19/3")
        self.assertEqual(medidas[U(201)]["fuente"], "wispro")
        self.assertEqual(medidas[U(202)], {"error": "sin ONT vinculada en Wispro"})
        self.assertIn("error", medidas[U(204)])  # Wispro respondió 404
        # La caja muestra la medición en vivo de ese contrato un rato.
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        por_id = {x["id"]: x for x in data["contratos"]}
        self.assertEqual(por_id[U(201)]["vivo"]["rx"], -20.1)
        self.assertIsNone(por_id[U(202)]["vivo"])
        # No se repite antes de VIVE_EN_VIVO.
        antes = self.wispro.contar(f"/contracts/{U(201)}/status_ont")
        self.ok("POST", "/api/integracion/nap/medir", {"elemento": nap["id"]})
        self.assertEqual(self.wispro.contar(f"/contracts/{U(201)}/status_ont"), antes)
        # Un cliente.
        a = self.cliente(red, "Gómez Ana", -58.1655, -26.1795)
        res = self.ok("POST", "/api/integracion/cliente/medir", {"elemento": a["id"]})
        self.assertEqual(res["medidas"][U(201)]["rx"], -20.1)
        b = self.cliente(red, "Nadie Conocido", -58.1, -26.1)
        self.assertEqual(self.pedir("POST", "/api/integracion/cliente/medir", {"elemento": b["id"]})[0], 409)

    def test_fallas(self):
        red, nap = self.red_con_caja("Fallas")
        self.configurar(red, token="token-malo")
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        self.assertIn("Wispro: no aceptó el token.", data["errores"])
        self.assertIn("panel", data)  # el panel sí respondió
        code, data = self.pedir("POST", "/api/integracion/nap/medir", {"elemento": nap["id"]})
        self.assertEqual(code, 502)
        self.assertIn("token", data["error"])
        # Panel caído: la caja igual muestra lo de Wispro, y no se reintenta en cada pedido.
        red2, nap2 = self.red_con_caja("Panel caído")
        self.configurar(red2)
        self.panel.caido = True
        try:
            data = self.ok("GET", f"/api/integracion/nap?elemento={nap2['id']}")
            self.assertTrue(any(e.startswith("Panel de la OLT: respondió 503") for e in data["errores"]), data["errores"])
            self.assertEqual(len(data["contratos"]), 5)
            self.assertIsNone(data["contratos"][0]["medida"])
            antes = len(self.panel.pedidos)
            self.ok("GET", f"/api/integracion/nap?elemento={nap2['id']}")
            self.assertEqual(len(self.panel.pedidos), antes)
        finally:
            self.panel.caido = False
        # Una OLT que el panel no tiene.
        red3, nap3 = self.red_con_caja("OLT que no está")
        self.configurar(red3, olts=(5,))
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap3['id']}")
        self.assertIn("Panel de la OLT: no tiene la OLT 5.", data["errores"])
        # Un panel que no existe (puerto cerrado).
        red4, nap4 = self.red_con_caja("Panel inexistente")
        self.configurar(red4)
        cfg = api.leer_config(self.config)
        cfg["redes"][str(red4)]["panel"]["url"] = f"http://127.0.0.1:{puerto_libre()}"
        api.guardar_config(self.config, cfg)
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap4['id']}")
        self.assertTrue(any(e.startswith("Panel de la OLT: rechazó la conexión") for e in data["errores"]), data["errores"])

    def test_comando(self):
        red, nap = self.red_con_caja("Comando ALVATIC")
        archivo = os.path.join(self.tmp.name, "otro.json")

        def correr(*args, entrada=None):
            extra = {"input": entrada} if entrada is not None else {"stdin": subprocess.DEVNULL}
            return subprocess.run([sys.executable, "-I", API_PY, "--db", self.db, "integraciones", *args,
                                   "--archivo", archivo], capture_output=True, text=True, timeout=60, **extra)

        r = correr("wispro", "Comando ALVATIC", "--token-stdin", "--wispro-url", self.wispro.url, entrada="malo\n")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no aceptó el token", r.stderr)
        self.assertFalse(os.path.exists(archivo))
        r = correr("wispro", str(red), "--token-stdin", "--wispro-url", self.wispro.url, entrada=f"{TOKEN}\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("3 NAPs, 6 contratos", r.stdout)
        self.assertEqual(stat.S_IMODE(os.stat(archivo).st_mode), 0o600)
        self.assertEqual(api.leer_config(archivo)["redes"][str(red)]["wispro"]["token"], TOKEN)
        # Varias OLTs y sin terminal: hay que decir cuál.
        r = correr("panel", str(red), self.panel.url)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--olt", r.stderr)
        r = correr("panel", str(red), self.panel.url, "--olt", "7")
        self.assertIn("no tiene la OLT 7", r.stderr)
        r = correr("panel", str(red), self.panel.url, "--olt", "1")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = correr("ver")
        self.assertIn("Comando ALVATIC", r.stdout)
        self.assertIn("…-123", r.stdout)
        self.assertNotIn(TOKEN, r.stdout)
        r = correr("probar", "Comando ALVATIC")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("Wispro: 3 NAPs, 6 contratos y 6 clientes", r.stdout)
        self.assertIn("Panel de la OLT: 3 ONTs de ALVATIC-MA5800-01", r.stdout)
        self.assertIn("Cajas NAP en traza: 1; encontradas en Wispro: 1.", r.stdout)
        self.assertIn("Contratos con ONT en Wispro: 4; con su ONT en el panel: 2.", r.stdout)
        r = correr("quitar", str(red), "panel")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("panel", api.leer_config(archivo)["redes"][str(red)])
        r = correr("wispro", "No existe", "--token-stdin", entrada="x\n")
        self.assertIn("No hay una red", r.stderr)


    # ------------------------------------------------- lo que encontró la revisión

    def nueva_caja(self, nombre_red):
        """Una red con su caja P5-C4 conectada a un Wispro y un panel propios de la prueba."""
        red, nap = self.red_con_caja(nombre_red)
        self.configurar(red)
        return red, nap

    def test_importar_dos_veces_a_la_vez_no_duplica(self):
        red, nap = self.nueva_caja("Doble toque")
        ids = [U(201), U(204)]
        self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")  # Wispro leído
        resultados = []

        def importar():
            resultados.append(self.pedir("POST", "/api/integracion/nap/importar", {"elemento": nap["id"], "contratos": ids}))

        hilos = [threading.Thread(target=importar) for _ in range(4)]
        for h in hilos:
            h.start()
        for h in hilos:
            h.join()
        self.assertTrue(all(code == 200 for code, _ in resultados), resultados)
        self.assertEqual(sum(len(d["elementos"]) for _, d in resultados), 2)
        clientes = [e for e in self.ok("GET", f"/api/red?red={red}")["elementos"]["features"] if e["properties"]["tipo"] == "cliente"]
        self.assertEqual(len(clientes), 2)

    def test_repetidos_y_dudosos(self):
        red, nap = self.nueva_caja("Repetidos")
        # Dos clientes dibujados con la misma ONT: el contrato queda "repetido" y no se agrega otro.
        a1 = self.cliente(red, "Ana 1", -58.1655, -26.1795, ont="HWTC90BCF28A")
        a2 = self.cliente(red, "Ana 2", -58.1656, -26.1796, ont="48575443 90BCF28A")
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        uno = {x["id"]: x for x in data["contratos"]}[U(201)]
        self.assertEqual({r["id"] for r in uno["traza"]["repetidos"]}, {a1["id"], a2["id"]})
        res = self.ok("POST", "/api/integracion/nap/importar", {"elemento": nap["id"], "contratos": [U(201)]})
        self.assertEqual(res["elementos"], [])
        self.assertEqual(res["omitidos"][0]["motivo"], "ya está en el mapa")
        # La ficha de cada uno avisa del otro.
        dc = self.ok("GET", f"/api/integracion/cliente?elemento={a1['id']}")
        self.assertEqual(dc["contrato"]["id"], U(201))
        self.assertEqual([r["id"] for r in dc["contrato"]["repetidos"]], [a2["id"]])

    def test_mismo_cliente_de_wispro_con_dos_contratos(self):
        red, nap = self.nueva_caja("Dos contratos")
        cfg = api.leer_config(self.config)
        # El cliente 120 (Gómez) tiene dos contratos en la caja: 201 y 207.
        extra = contrato(7, 1, 1, sn="HWTC00000007", lat="-26.1795", lon="-58.1655", numero=397)
        CONTRATOS.append(extra)
        try:
            api.guardar_config(self.config, cfg)  # firma nueva: se vuelve a leer Wispro
            os.utime(self.config, ns=(time.time_ns(), time.time_ns() + 7))
            c = self.cliente(red, "Casa de Ana", -58.1655, -26.1795, abonado="120")
            data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
            por_id = {x["id"]: x for x in data["contratos"]}
            # El abonado no alcanza para elegir: los dos quedan para confirmar y ninguno se agrega.
            for cid in (U(201), U(207)):
                self.assertEqual([d["id"] for d in por_id[cid]["traza"]["dudosos"]], [c["id"]])
            res = self.ok("POST", "/api/integracion/nap/importar", {"elemento": nap["id"], "contratos": [U(201), U(207)]})
            self.assertEqual(res["elementos"], [])
            dc = self.ok("GET", f"/api/integracion/cliente?elemento={c['id']}")
            self.assertIsNone(dc["contrato"])
            self.assertEqual({p["id"] for p in dc["posibles"]}, {U(201), U(207)})
            # Confirmado uno, el otro se puede agregar.
            res = self.ok("POST", "/api/integracion/vincular", {"cliente": c["id"], "contrato": U(207)})
            self.assertEqual(res["elemento"]["properties"]["datos"]["wispro_contrato"], U(207))
            self.assertEqual(res["elemento"]["properties"]["datos"]["contrato"], "397")
            self.assertEqual(res["elemento"]["properties"]["datos"]["ont"], "HWTC00000007")
            data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
            por_id = {x["id"]: x for x in data["contratos"]}
            self.assertEqual(por_id[U(207)]["traza"]["por"], "vinculado")
            self.assertIsNone(por_id[U(201)]["traza"])
            res = self.ok("POST", "/api/integracion/nap/importar", {"elemento": nap["id"], "contratos": [U(201)]})
            self.assertEqual(len(res["elementos"]), 1)
            # Validaciones de vincular.
            self.assertEqual(self.pedir("POST", "/api/integracion/vincular", {"cliente": c["id"], "contrato": "x"})[0], 400)
            self.assertEqual(self.pedir("POST", "/api/integracion/vincular", {"cliente": c["id"], "contrato": U(999)})[0], 404)
            self.assertEqual(self.pedir("POST", "/api/integracion/vincular", {"cliente": nap["id"], "contrato": U(201)})[0], 400)
        finally:
            CONTRATOS.remove(extra)
            os.utime(self.config, ns=(time.time_ns(), time.time_ns() + 9))

    def test_numero_lejos(self):
        red, nap = self.nueva_caja("Número lejos")
        # Abonado 120 (el de Gómez), pero a 4,4 km del contrato y de su NAP: no se da por
        # hecho; se muestra para confirmar (con la distancia), sin frenar agregarlo al mapa.
        lejos = self.cliente(red, "Rodas Ramona", -58.21, -26.18, abonado="120")
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        uno = {x["id"]: x for x in data["contratos"]}[U(201)]
        self.assertEqual([(d["id"], d["por"]) for d in uno["traza"]["dudosos"]], [(lejos["id"], "abonado")])
        self.assertGreater(uno["traza"]["dudosos"][0]["lejos_m"], 4000)
        dc = self.ok("GET", f"/api/integracion/cliente?elemento={lejos['id']}")
        self.assertIsNone(dc["contrato"])
        self.assertEqual([(x["id"], x["por"]) for x in dc["posibles"]], [(U(201), "abonado")])
        self.assertGreater(dc["posibles"][0]["lejos_m"], 4000)
        # "No es": no se vuelve a proponer (y se puede deshacer).
        res = self.ok("POST", "/api/integracion/desvincular", {"cliente": lejos["id"], "contrato": U(201)})
        self.assertEqual(res["elemento"]["properties"]["datos"]["wispro_no"], U(201))
        self.assertEqual(res["elemento"]["properties"]["datos"]["abonado"], "120")  # lo que anotó el usuario queda
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        self.assertIsNone({x["id"]: x for x in data["contratos"]}[U(201)]["traza"])
        dc = self.ok("GET", f"/api/integracion/cliente?elemento={lejos['id']}")
        self.assertNotIn("posibles", dc)
        self.assertEqual([(x["id"], x["numero"]) for x in dc["descartados"]], [(U(201), 391)])
        res = self.ok("POST", "/api/integracion/desvincular", {"cliente": lejos["id"], "contrato": U(201), "deshacer": True})
        self.assertNotIn("wispro_no", res["elemento"]["properties"]["datos"])
        self.assertEqual(self.ok("GET", f"/api/integracion/cliente?elemento={lejos['id']}")["posibles"][0]["id"], U(201))
        self.assertEqual(self.pedir("POST", "/api/integracion/desvincular",
                                    {"cliente": lejos["id"], "contrato": U(201), "deshacer": "sí"})[0], 400)
        # Lo lejano no frena agregar el contrato; después, su ficha dice con quién coincide.
        res = self.ok("POST", "/api/integracion/nap/importar", {"elemento": nap["id"], "contratos": [U(201)]})
        self.assertEqual(len(res["elementos"]), 1)
        nueva = res["elementos"][0]
        dc = self.ok("GET", f"/api/integracion/cliente?elemento={lejos['id']}")
        self.assertNotIn("posibles", dc)
        self.assertEqual(dc["ocupados"], [{"id": U(201), "numero": 391, "cliente": "Gómez, Ana", "nap_nombre": "P5C4",
                                           "por": "abonado", "en_mapa": [{"id": nueva["id"], "nombre": "Gómez, Ana"}]}])

    def test_no_es_no_pisa_lo_que_se_anota(self):
        # "No es" descarta lo dudoso (el nombre); si después se anota el n.º de contrato
        # en la ficha, eso manda.
        red, nap = self.nueva_caja("No es y después el dato")
        c = self.cliente(red, "Luis Pereyra", -58.16585, -26.17962)
        self.assertEqual(self.ok("GET", f"/api/integracion/cliente?elemento={c['id']}")["contrato"]["por"], "nombre")
        props = self.ok("POST", "/api/integracion/desvincular", {"cliente": c["id"], "contrato": U(202)})["elemento"]["properties"]
        self.assertIsNone(self.ok("GET", f"/api/integracion/cliente?elemento={c['id']}")["contrato"])
        self.ok("PUT", f"/api/elementos/{c['id']}", {"datos": {**props["datos"], "contrato": "392"}, "version": props["version"]})
        dc = self.ok("GET", f"/api/integracion/cliente?elemento={c['id']}")
        self.assertEqual((dc["contrato"]["id"], dc["contrato"]["por"]), (U(202), "contrato"))

    def test_numero_cerca_de_la_nap(self):
        # El contrato está mal ubicado en Wispro (en la oficina, a 4 km), pero el cliente
        # está al lado de su NAP: el número vale.
        red, nap = self.nueva_caja("Ubicación mala")
        extra = contrato(8, 4, 1, sn=None, lat="-26.1800", lon="-58.2100", numero=777)
        CONTRATOS.append(extra)
        try:
            os.utime(self.config, ns=(time.time_ns(), time.time_ns() + 15))
            c = self.cliente(red, "Ramona", -58.1662, -26.1802, contrato="777")
            data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
            self.assertEqual({x["id"]: x for x in data["contratos"]}[U(208)]["traza"],
                             {"id": c["id"], "nombre": "Ramona", "por": "contrato"})
        finally:
            CONTRATOS.remove(extra)
            os.utime(self.config, ns=(time.time_ns(), time.time_ns() + 17))

    def test_nombre_que_tienen_dos_queda_para_confirmar(self):
        # Gómez Ana tiene dos contratos en la caja y está dibujada una vez: no se sabe
        # cuál es, así que no se agrega ninguno sin confirmar (sería un repetido).
        red, nap = self.nueva_caja("Nombre de dos")
        extra = contrato(7, 1, 1, sn="HWTC00000007", lat="-26.1795", lon="-58.1655", numero=397)
        CONTRATOS.append(extra)
        try:
            os.utime(self.config, ns=(time.time_ns(), time.time_ns() + 19))
            c = self.cliente(red, "Ana Gómez", -58.1655, -26.1796)
            data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
            por_id = {x["id"]: x for x in data["contratos"]}
            for cid in (U(201), U(207)):
                self.assertEqual([(d["id"], d["por"]) for d in por_id[cid]["traza"]["dudosos"]], [(c["id"], "nombre")])
            res = self.ok("POST", "/api/integracion/nap/importar", {"elemento": nap["id"], "contratos": [U(201), U(207)]})
            self.assertEqual(res["elementos"], [])
        finally:
            CONTRATOS.remove(extra)
            os.utime(self.config, ns=(time.time_ns(), time.time_ns() + 21))

    def test_repetido_por_otro_criterio(self):
        # La oficina agregó a Gómez desde Wispro (queda vinculada) y un técnico la había
        # dibujado aparte, con su ONT: es la misma, dos veces en el mapa.
        red, nap = self.nueva_caja("Repetido cruzado")
        importada = self.ok("POST", "/api/integracion/nap/importar", {"elemento": nap["id"], "contratos": [U(201)]})["elementos"][0]
        dibujada = self.cliente(red, "Ana", -58.1650, -26.1790, ont="4857544390BCF28A")
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        uno = {x["id"]: x for x in data["contratos"]}[U(201)]
        self.assertEqual([r["id"] for r in uno["traza"]["repetidos"]], [importada["id"], dibujada["id"]])
        self.assertEqual(uno["traza"]["por"], "ont")
        dc = self.ok("GET", f"/api/integracion/cliente?elemento={dibujada['id']}")
        self.assertEqual((dc["contrato"]["id"], dc["contrato"]["por"]), (U(201), "ont"))
        self.assertEqual([r["id"] for r in dc["contrato"]["repetidos"]], [importada["id"]])

    def test_vincular_un_contrato_con_un_cliente_y_deshacer(self):
        red, nap = self.nueva_caja("Vincular y deshacer")
        a = self.cliente(red, "Vecina A", -58.1640, -26.1790)
        b = self.cliente(red, "Vecina B", -58.1641, -26.1791, ont="HWTC12345678")
        res = self.ok("POST", "/api/integracion/vincular", {"cliente": a["id"], "contrato": U(201)})
        datos = res["elemento"]["properties"]["datos"]
        self.assertEqual((datos["contrato"], datos["abonado"], datos["ont"]), ("391", "120", "HWTC90BCF28A"))
        # El mismo contrato con otro cliente: no (un contrato, un cliente).
        code, err = self.pedir("POST", "/api/integracion/vincular", {"cliente": b["id"], "contrato": U(201)})
        self.assertEqual(code, 409)
        self.assertIn("Vecina A", err["error"])
        # Un cliente vinculado con un contrato que sigue en Wispro no pasa a otro sin deshacer.
        self.assertEqual(self.pedir("POST", "/api/integracion/vincular", {"cliente": a["id"], "contrato": U(204)})[0], 409)
        # Deshacer: se va el vínculo y lo que había completado; no se vuelve a proponer.
        res = self.ok("POST", "/api/integracion/desvincular", {"cliente": a["id"], "contrato": U(201)})
        datos = res["elemento"]["properties"]["datos"]
        for k in ("wispro_contrato", "contrato", "abonado", "ont", "direccion", "wispro_llenados"):
            self.assertNotIn(k, datos)
        self.assertEqual(datos["wispro_no"], U(201))
        # B tenía su ONT anotada: vincularlo no la pisa, y deshacerlo no la borra.
        res = self.ok("POST", "/api/integracion/vincular", {"cliente": b["id"], "contrato": U(201)})
        self.assertEqual(res["elemento"]["properties"]["datos"]["ont"], "HWTC12345678")
        res = self.ok("POST", "/api/integracion/desvincular", {"cliente": b["id"], "contrato": U(201)})
        self.assertEqual(res["elemento"]["properties"]["datos"]["ont"], "HWTC12345678")
        # Vincular de nuevo quita el "no es".
        res = self.ok("POST", "/api/integracion/vincular", {"cliente": a["id"], "contrato": U(201)})
        self.assertNotIn("wispro_no", res["elemento"]["properties"]["datos"])
        self.assertEqual(self.pedir("POST", "/api/integracion/desvincular", {"cliente": nap["id"], "contrato": U(201)})[0], 400)

    def test_acciones_con_la_ultima_lectura(self):
        # Medir, agregar o vincular no esperan a que Wispro vuelva a contestar todo si hay
        # una lectura de hace minutos (aunque para las fichas ya esté vencida).
        red, nap = self.nueva_caja("Acción con lectura anterior")
        self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        integ = api.Handler.integraciones
        with integ._candado:
            for k, (cuando, valor) in list(integ._cache.items()):
                if k[1:] == ("wispro", red):
                    integ._cache[k] = (cuando - 600, valor)  # hace 10 minutos
        naps = self.wispro.rutas["/naps"]
        self.wispro.rutas["/naps"] = lambda q, h: (time.sleep(5), naps(q, h))[1]
        try:
            t = time.monotonic()
            res = self.ok("POST", "/api/integracion/nap/medir", {"elemento": nap["id"]})
            self.assertLess(time.monotonic() - t, 3)
            self.assertEqual(res["medidas"][U(201)]["rx"], -20.1)
        finally:
            self.wispro.rutas["/naps"] = naps

    def test_traer_la_red_de_wispro(self):
        red = self.ok("POST", "/api/redes", {"nombre": "Traer todo"}, status=201)["red"]["id"]
        self.configurar(red)
        # Una caja dibujada a mano a 15 m de P5C5, sin vincular: podría ser la misma, no
        # se agrega otra encima salvo que se pida (P5C4 queda a más de 150 m).
        nap001 = self.ok("POST", "/api/elementos", {"red": red, "tipo": "nap", "nombre": "NAP-001", "lon": -58.1671,
                                                    "lat": -26.1811}, status=201)["elemento"]["id"]
        previa = self.ok("GET", f"/api/integracion/importacion?red={red}")
        self.assertEqual((previa["cajas"]["total"], previa["cajas"]["nuevas"], previa["cajas"]["ya"]), (3, 2, 0))
        self.assertEqual(previa["cajas"]["omitidas"], [])
        self.assertEqual(previa["cajas"]["dudosas"], [{"id": U(2), "nombre": "P5C5", "distancia_m": 15,
                                                       "caja": {"id": nap001, "nombre": "NAP-001"}}])
        self.assertIsNone(previa["ultima"])
        self.assertEqual((previa["clientes"]["total"], previa["clientes"]["nuevos"], previa["clientes"]["ya"]), (6, 5, 0))
        self.assertEqual(previa["clientes"]["omitidos"], [{"motivo": "no tiene ubicación en Wispro", "cantidad": 1,
                                                          "ejemplos": ["Sin Ubicación #395"]}])
        self.assertEqual(len(self.ok("GET", f"/api/red?red={red}")["elementos"]["features"]), 1)  # no cambió nada
        # Agregar todo de una vez: una sola versión.
        res = self.ok("POST", "/api/integracion/importacion", {"red": red, "cajas": True, "clientes": True})
        self.assertEqual(res["agregados"], {"cajas": 2, "clientes": 5})
        self.assertEqual(len(res["elementos"]), 7)
        self.assertEqual({e["properties"]["version"] for e in res["elementos"]}, {res["version"]})
        cajas = {e["properties"]["nombre"]: e for e in res["elementos"] if e["properties"]["tipo"] == "nap"}
        self.assertEqual(set(cajas), {"P5C4", "P9C1"})
        p5c4 = cajas["P5C4"]
        self.assertEqual(p5c4["properties"]["datos"]["wispro_nap"], U(1))
        self.assertEqual(p5c4["properties"]["datos"]["puertos"], "16")
        self.assertEqual(p5c4["geometry"]["coordinates"], [-58.166, -26.18])
        # La caja agregada ya muestra sus contratos, vinculados con los clientes agregados.
        data = self.ok("GET", f"/api/integracion/nap?elemento={p5c4['id']}")
        self.assertEqual(data["nap"]["por"], "vinculada")
        por_id = {x["id"]: x for x in data["contratos"]}
        self.assertEqual(por_id[U(201)]["traza"]["por"], "vinculado")
        self.assertIsNone(por_id[U(205)]["traza"])  # sin ubicación: no se agregó
        # Otra vez: no hay nada nuevo (P5C5 sigue esperando), y se ve la importación para deshacerla.
        previa = self.ok("GET", f"/api/integracion/importacion?red={red}")
        self.assertEqual((previa["cajas"]["nuevas"], previa["cajas"]["ya"], len(previa["cajas"]["dudosas"])), (0, 2, 1))
        self.assertEqual((previa["clientes"]["nuevos"], previa["clientes"]["ya"]), (0, 5))
        self.assertEqual((previa["ultima"]["version"], previa["ultima"]["elementos"], previa["ultima"]["usuario"]),
                         (res["version"], 7, "ana"))
        self.assertEqual(self.ok("POST", "/api/integracion/importacion", {"red": red})["elementos"], [])
        # Deshacer: se va lo agregado, salvo lo que se tocó después.
        cliente = next(e for e in res["elementos"] if e["properties"]["tipo"] == "cliente")
        self.ok("PUT", f"/api/elementos/{cliente['id']}", {"notas": "visto en la calle",
                                                          "version": cliente["properties"]["version"]})
        des = self.ok("POST", "/api/integracion/importacion/deshacer", {"red": red, "version": res["version"]})
        self.assertEqual((des["quitados"], des["quedan"]), (6, 1))
        self.assertTrue(all(e["borrado"] for e in des["elementos"]))
        previa = self.ok("GET", f"/api/integracion/importacion?red={red}")
        self.assertEqual((previa["cajas"]["nuevas"], previa["clientes"]["nuevos"], previa["clientes"]["ya"]), (2, 4, 1))
        self.assertEqual((previa["ultima"]["version"], previa["ultima"]["elementos"]), (res["version"], 1))
        # Solo cajas, y P5C5 también (es otra caja que NAP-001).
        res = self.ok("POST", "/api/integracion/importacion", {"red": red, "cajas": True, "clientes": False,
                                                               "igual": [U(2)]})
        self.assertEqual(res["agregados"], {"cajas": 3, "clientes": 0})
        previa = self.ok("GET", f"/api/integracion/importacion?red={red}")
        self.assertEqual((previa["cajas"]["nuevas"], previa["cajas"]["ya"], previa["cajas"]["dudosas"]), (0, 3, []))
        self.assertEqual((previa["ultima"]["version"], previa["ultima"]["elementos"]), (res["version"], 3))
        # Agregar desde la ficha de una caja no cuenta como importación de la red.
        p5c4 = next(e["id"] for e in res["elementos"] if e["properties"]["nombre"] == "P5C4")
        desde_caja = self.ok("POST", "/api/integracion/nap/importar", {"elemento": p5c4, "contratos": [U(203)]})
        self.assertEqual((len(desde_caja["elementos"]), desde_caja["omitidos"]), (1, []))
        self.assertEqual(self.ok("GET", f"/api/integracion/importacion?red={red}")["ultima"]["version"], res["version"])
        # Validaciones.
        self.assertEqual(self.pedir("POST", "/api/integracion/importacion/deshacer", {"red": red, "version": 999999})[0], 404)
        self.assertEqual(self.pedir("POST", "/api/integracion/importacion/deshacer", {"red": red, "version": "x"})[0], 400)
        self.assertEqual(self.pedir("POST", "/api/integracion/importacion", {"red": red, "cajas": False,
                                                                            "clientes": False})[0], 400)
        self.assertEqual(self.pedir("POST", "/api/integracion/importacion", {"red": red, "cajas": "si"})[0], 400)
        self.assertEqual(self.pedir("POST", "/api/integracion/importacion", {"red": red, "igual": U(2)})[0], 400)
        self.assertEqual(self.pedir("POST", "/api/integracion/importacion", {"red": red, "igual": [2]})[0], 400)
        sin = self.ok("POST", "/api/redes", {"nombre": "Sin Wispro"}, status=201)["red"]["id"]
        self.assertEqual(self.pedir("GET", f"/api/integracion/importacion?red={sin}")[0], 409)
        self.assertEqual(self.pedir("GET", "/api/integracion/importacion?red=999999")[0], 404)

    def test_traer_naps_repetidas_y_sin_id(self):
        # Wispro entrega de a páginas: si la lista se corre mientras se lee, una NAP puede venir dos veces.
        sin_id = dict(NAPS[0], id=None, name="Sin id")
        dw = api.DatosWispro(NAPS + [NAPS[0], sin_id], [], [], [])
        plan = api.plan_importacion(dw, [], [])
        self.assertEqual((plan["cajas"]["total"], plan["cajas"]["nuevas"]), (3, 3))
        self.assertEqual(sorted(c["nombre"] for c in plan["_cajas"]), ["P5C4", "P5C5", "P9C1"])
        # La capacidad puede venir como texto.
        dw = api.DatosWispro([dict(NAPS[0], capacity="24")], [], [], [])
        self.assertEqual(api.plan_importacion(dw, [], [])["_cajas"][0]["datos"]["puertos"], "24")

    def test_traer_con_naps_amontonadas(self):
        # Wispro con muchas NAPs a pocos metros (ubicación cargada por defecto): una caja del
        # mapa sin vincular aparta solo la más cercana; las demás se agregan.
        juntas = [dict(NAPS[0], id=U(60 + k), name=f"P8C{k}", latitude=f"{-26.1810 + k * 0.0001:.4f}",
                       longitude="-58.1670") for k in range(1, 9)]  # cada 11 m hacia el norte
        dw = api.DatosWispro(juntas, [], [], [])
        fila = lambda i, nombre, lon, lat: {"id": i, "nombre": nombre, "lon": lon, "lat": lat, "datos": "{}"}
        plan = api.plan_importacion(dw, [fila(1, "NAP-001", -58.1670, -26.1810)], [])
        self.assertEqual([(x["nombre"], x["distancia_m"]) for x in plan["cajas"]["dudosas"]], [("P8C1", 11)])
        self.assertEqual(plan["cajas"]["nuevas"], 7)
        # Dos cajas sueltas: cada una aparta una NAP distinta (la más cercana que quede).
        plan = api.plan_importacion(dw, [fila(1, "NAP-001", -58.1670, -26.1810), fila(2, "NAP-002", -58.1670, -26.1809)], [])
        self.assertEqual(sorted((x["nombre"], x["caja"]["nombre"]) for x in plan["cajas"]["dudosas"]),
                         [("P8C1", "NAP-002"), ("P8C2", "NAP-001")])
        self.assertEqual(plan["cajas"]["nuevas"], 6)
        # Muy lejos (más de 150 m), ninguna queda aparte.
        plan = api.plan_importacion(dw, [fila(1, "Lejos", -58.1700, -26.1850)], [])
        self.assertEqual((plan["cajas"]["dudosas"], plan["cajas"]["nuevas"]), ([], 8))

    def test_traer_con_la_misma_cuenta_en_otra_red(self):
        a = self.ok("POST", "/api/redes", {"nombre": "Cuenta A"}, status=201)["red"]["id"]
        b = self.ok("POST", "/api/redes", {"nombre": "Cuenta B"}, status=201)["red"]["id"]
        self.configurar(a)
        self.configurar(b)
        self.assertIn("Cuenta B", self.ok("GET", f"/api/integracion/importacion?red={a}")["misma_cuenta"])
        self.assertNotIn("Cuenta A", self.ok("GET", f"/api/integracion/importacion?red={a}")["misma_cuenta"])

    def test_traer_la_red_dos_veces_a_la_vez(self):
        red = self.ok("POST", "/api/redes", {"nombre": "Traer dos veces"}, status=201)["red"]["id"]
        self.configurar(red)
        self.ok("GET", f"/api/integracion/importacion?red={red}")  # Wispro leído
        resultados = []

        def traer():
            resultados.append(self.pedir("POST", "/api/integracion/importacion", {"red": red}))

        hilos = [threading.Thread(target=traer) for _ in range(3)]
        for t in hilos:
            t.start()
        for t in hilos:
            t.join()
        self.assertTrue(all(code == 200 for code, _ in resultados), resultados)
        self.assertEqual(sorted(len(r["elementos"]) for _, r in resultados), [0, 0, 8])
        elementos = self.ok("GET", f"/api/red?red={red}")["elementos"]["features"]
        self.assertEqual(len(elementos), 8)  # 3 cajas y 5 clientes, una sola vez

    def test_comando_ver_olts(self):
        red, _ = self.red_con_caja("Ver OLTs")
        archivo = os.path.join(self.tmp.name, "ver-olts.json")
        for olts, esperado in ((1, "(OLT 1)"), ("1362", "(OLT 1362)"), (None, "sin OLT elegida")):
            panel = {"url": "http://10.0.0.1:8080"}
            if olts is not None:
                panel["olts"] = olts
            api.guardar_config(archivo, {"redes": {str(red): {"panel": panel}}})
            r = subprocess.run([sys.executable, "-I", API_PY, "--db", self.db, "integraciones", "ver", "--archivo", archivo],
                               capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn(esperado, r.stdout)

    def test_ubicacion_lejos_de_la_caja(self):
        red, nap = self.nueva_caja("Lejos de la caja")
        extra = contrato(8, 2, 1, sn=None, lat="26.1796", lon="-58.1658")  # sin el signo menos
        CONTRATOS.append(extra)
        try:
            os.utime(self.config, ns=(time.time_ns(), time.time_ns() + 11))
            data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
            self.assertGreater({x["id"]: x for x in data["contratos"]}[U(208)]["lejos_m"], 5_000_000)
            res = self.ok("POST", "/api/integracion/nap/importar", {"elemento": nap["id"], "contratos": [U(208)]})
            self.assertEqual(res["elementos"], [])
            self.assertIn("km de la caja", res["omitidos"][0]["motivo"])
        finally:
            CONTRATOS.remove(extra)
            os.utime(self.config, ns=(time.time_ns(), time.time_ns() + 13))

    def test_varias_olt_sin_elegir(self):
        red, nap = self.nueva_caja("Sin OLT elegida")
        cfg = api.leer_config(self.config)
        cfg["redes"][str(red)]["panel"].pop("olts")
        api.guardar_config(self.config, cfg)
        data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        self.assertTrue(any("varias OLT" in e for e in data["errores"]), data["errores"])
        self.assertNotIn("panel", data)  # nada de la OLT de la otra empresa
        self.assertNotIn("ONSYS", json.dumps(data))

    def test_ont_ajena_por_numero(self):
        red, nap = self.nueva_caja("ONT ajena")
        # El contrato 203 no tiene serie; la ONT con "#405" tiene la serie de otro contrato: no es la suya.
        ONTS[2]["sn"] = "48575443D87F4EB6"
        try:
            os.utime(self.config, ns=(time.time_ns(), time.time_ns() + 15))
            data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
            self.assertIsNone({x["id"]: x for x in data["contratos"]}[U(203)]["medida"])
        finally:
            ONTS[2]["sn"] = "48575443AAAAAAAA"
            os.utime(self.config, ns=(time.time_ns(), time.time_ns() + 17))

    def test_serie_repetida_en_el_panel(self):
        dp = api.DatosPanel([{"id": 1, "name": "OLT"}], {1: [
            {"id": 1, "sn": "4857544390BCF28A", "run_state": "offline", "last_seen": "2026-10-14T10:00:00Z", "rx_power_dbm": None},
            {"id": 2, "sn": "4857544390BCF28A", "run_state": "online", "last_seen": "2026-10-14T09:00:00Z", "rx_power_dbm": "-20"},
        ]}, None)
        self.assertEqual(dp.ont("HWTC90BCF28A")[0]["panel_id"], 2)

    def test_lectura_anterior_si_falla(self):
        red, nap = self.nueva_caja("Respaldo")
        self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        integ = api.Handler.integraciones
        # Pasado el tiempo de vida, Wispro falla: se muestra lo anterior, con aviso.
        with integ._candado:
            for clave, (cuando, valor) in list(integ._cache.items()):
                if clave[1] == "wispro" and clave[2] == red:
                    integ._cache[clave] = (cuando - api.VIVE_WISPRO - 1, valor)
        self.wispro.caido = True
        try:
            data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
        finally:
            self.wispro.caido = False
        self.assertEqual(len(data["contratos"]), 5)
        self.assertTrue(any(e.startswith("Wispro: respondió 503; se muestra lo leído") for e in data["errores"]), data["errores"])

    def test_no_sigue_redirecciones(self):
        otro = Falso("otro")
        recibido = []
        otro.rutas["/naps"] = lambda q, h: (recibido.append(h.get("Authorization")) or 200, {"status": 200, "data": []})
        desvio = Falso("desvio")
        try:
            desvio.rutas["/naps"] = lambda q, h: (302, {"detail": "moved"}, {"Location": f"{otro.url}/naps"})
            w = api.Wispro(TOKEN, desvio.url)
            with self.assertRaises(api.IntegracionError) as ctx:
                w.get("/naps")
            self.assertIn("302", str(ctx.exception))
            self.assertEqual(recibido, [])
        finally:
            otro.cerrar()
            desvio.cerrar()

    def test_panel_que_corta_las_paginas(self):
        p = Falso("panel200")
        todas = [{"id": i, "sn": f"48575443{i:08X}"} for i in range(1, 684)]
        p.rutas["/api/olts/1/onts"] = lambda q, h: (200, todas[int(q["offset"][0]):][:min(200, int(q["limit"][0]))])
        p.rutas["/api/olts/2/onts"] = lambda q, h: (200, todas[:500])  # ignora offset
        try:
            self.assertEqual(len(api.Panel(p.url).onts(1)), 683)
            self.assertEqual(len(api.Panel(p.url).onts(2)), 500)
        finally:
            p.cerrar()

    def test_plazos(self):
        red, nap = self.nueva_caja("Lento")
        lento = Falso("lento")
        lento.rutas["/api/olts"] = lambda q, h: (time.sleep(3) or 200, [{"id": 1, "name": "OLT"}])
        cfg = api.leer_config(self.config)
        cfg["redes"][str(red)]["panel"]["url"] = lento.url
        api.guardar_config(self.config, cfg)
        antes = api.PLAZO_DATOS
        api.PLAZO_DATOS = 1
        try:
            t = time.monotonic()
            data = self.ok("GET", f"/api/integracion/nap?elemento={nap['id']}")
            self.assertLess(time.monotonic() - t, 2.5)
            self.assertTrue(any("está tardando" in e for e in data["errores"]), data["errores"])
            self.assertEqual(len(data["contratos"]), 5)  # Wispro sí llegó
        finally:
            api.PLAZO_DATOS = antes
            time.sleep(2.5)
            lento.cerrar()

    def test_comando_sin_olts_de_wispro(self):
        red, _ = self.red_con_caja("Sin OLTs en Wispro")
        archivo = os.path.join(self.tmp.name, "sin-olts.json")
        w = Falso("wispro-sin-olts")
        w.rutas.update({k: v for k, v in self.wispro.rutas.items() if k in ("/naps", "/contracts")})
        try:
            r = subprocess.run([sys.executable, "-I", API_PY, "--db", self.db, "integraciones", "wispro", str(red),
                                "--token-stdin", "--wispro-url", w.url, "--archivo", archivo],
                               input=f"{TOKEN}\n", capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            r = subprocess.run([sys.executable, "-I", API_PY, "--db", self.db, "integraciones", "ver",
                                "--archivo", self.db], capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn(".json aparte", r.stderr)
        finally:
            w.cerrar()


if __name__ == "__main__":
    unittest.main()
