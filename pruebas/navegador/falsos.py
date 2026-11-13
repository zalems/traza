#!/usr/bin/env python3
"""Wispro y panel de la OLT falsos para las pruebas en navegador (puertos 18091 y 18092).

Datos fijos: 10 NAPs (HP1C1…HP1C10) en 5 puertos PON, 63 contratos con su ONT.
  0/1/0  HP1C1, HP1C2   todo en línea, buena señal (HP1C2 llena: 8 de 8)
  0/1/1  HP1C3, HP1C4   HP1C3 con señal justa y una crítica, bajando 0,6 dB por semana
  0/1/2  HP1C5, HP1C6   HP1C5 caída entera hace 3 h (LOS); HP1C6 en línea
  0/1/3  HP1C7, HP1C8   PON caído hace 40 min (LOS)
  0/2/0  HP1C9, HP1C10  en línea, dos ONT sin energía; HP1C9 con 9 contratos y 8 bocas
Además 3 ONT sin contrato en 0/2/0 y una OLT de otra empresa (1362) que no tiene que verse.
Control: GET /_control?caer=0/1/0 | volver=0/1/0 | atraso=SEGUNDOS (lectura vieja del panel).
"""

import json
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

TOKEN = "token-e2e-0123456789"
U = "00000000-0000-4000-8000-{:012d}".format
LON0, LAT0 = -58.1700, -26.1800
NOMBRES = ["Acosta Marta", "Benítez Raúl", "Cabrera Lucía", "Duarte Hugo", "Escobar Nilda", "Franco Julio",
           "Giménez Rosa", "Ibarra Pablo", "Juárez Elsa", "Ledesma Omar", "Maidana Alba", "Núñez Darío",
           "Ojeda Clara", "Paredes Iván", "Quiroga Inés", "Romero Saúl", "Sosa Mirta", "Toledo Abel",
           "Ugarte Zulma", "Vera Ramón", "Zárate Olga"]
PON = [(1, 0), (1, 0), (1, 1), (1, 1), (1, 2), (1, 2), (1, 3), (1, 3), (2, 0), (2, 0)]
CUANTOS = [6, 8, 7, 5, 6, 7, 6, 5, 9, 4]
CAPACIDAD = [16, 8, 16, 16, 16, 16, 16, 16, 8, 16]

estado = {"caidos": {}, "atraso": 0}  # "slot/port" -> cuándo cayó (control)
candado = threading.Lock()


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ahora():
    return datetime.now(timezone.utc)


NAPS, CLIENTES, CONTRATOS, BASE_ONTS = [], [], [], []


def armar():
    n = 0
    ont_en_pon = {}
    for i in range(10):
        slot, port = PON[i]
        lon = LON0 + 0.0022 * (i % 5 + 1)
        lat = LAT0 - 0.0019 * (i // 5 + 1)
        NAPS.append({"id": U(i + 1), "public_id": i + 1, "name": f"HP1C{i + 1}", "details": None, "capacity": CAPACIDAD[i],
                     "olt_id": U(900), "fbp": f"0/{slot}/{port}", "contracts_count": CUANTOS[i],
                     "latitude": f"{lat:.6f}", "longitude": f"{lon:.6f}"})
        for k in range(CUANTOS[i]):
            n += 1
            nombre = f"{NOMBRES[n % len(NOMBRES)]} {n}"
            clon = lon + 0.00035 * ((k % 4) - 1.5)
            clat = lat + 0.00030 * ((k // 4) - 0.8) + 0.0004
            CLIENTES.append({"id": U(1000 + n), "public_id": 500 + n, "name": nombre,
                             "latitude": f"{clat:.6f}", "longitude": f"{clon:.6f}"})
            sn_hex = f"48575443{0x9A000000 + n:08X}"
            con_sn = not (i == 0 and k == 2)  # un contrato sin serie: se encuentra por "#numero"
            CONTRATOS.append({"id": U(2000 + n), "public_id": 1000 + n, "client_id": U(1000 + n), "state": "enabled",
                              "nap_id": U(i + 1), "nap_name": f"HP1C{i + 1}",
                              "ont_serial_number": f"HWTC{0x9A000000 + n:08X}" if con_sn else None,
                              "interface_gpon": None, "ont_number": None, "latitude": f"{clat:.6f}",
                              "longitude": f"{clon:.6f}", "address_street": "Av. 25 de Mayo",
                              "address_number": str(100 + n), "olt_id": U(900), "pppoe_password": "secreto"})
            ont_id = ont_en_pon.get((slot, port), 0)
            ont_en_pon[(slot, port)] = ont_id + 1
            rx = -19.0 - ((n * 37) % 40) / 10  # entre -19 y -23
            if i == 2:  # HP1C3: justa
                rx = -25.4 - (k % 4) * 0.5
                if k == 5:
                    rx = -28.6
            BASE_ONTS.append({"id": 100 + n, "slot": slot, "port": port, "ont_id": ont_id, "sn": sn_hex,
                              "description": f"#{1000 + n} {nombre}", "rx": rx, "nap": i, "k": k})
    for j, desc in enumerate(["Oficina técnica", "Prueba laboratorio", ""]):
        ont_id = ont_en_pon.get((2, 0), 0)
        ont_en_pon[(2, 0)] = ont_id + 1
        BASE_ONTS.append({"id": 900 + j, "slot": 2, "port": 0, "ont_id": ont_id, "sn": f"48575443{0xBB000000 + j:08X}",
                          "description": desc, "rx": -20.5 - j, "nap": None, "k": j})


armar()


def onts_ahora():
    t = ahora()
    with candado:
        caidos, atraso = dict(estado["caidos"]), estado["atraso"]
    visto = iso(t - timedelta(seconds=45 + atraso))
    out = []
    for b in BASE_ONTS:
        o = {"id": b["id"], "slot": b["slot"], "port": b["port"], "ont_id": b["ont_id"], "sn": b["sn"],
             "description": b["description"], "run_state": "online", "rx_power_dbm": f"{b['rx']:.2f}",
             "tx_power_dbm": "2.31", "last_seen": visto, "technology": "gpon",
             "rx_status": "critical" if b["rx"] <= -28 else "warning" if b["rx"] <= -25 else "ok"}
        cae, causa = None, None
        if b["nap"] == 4:  # HP1C5
            cae, causa = t - timedelta(hours=3, seconds=b["k"] * 7), "LOS"
        elif b["nap"] in (6, 7):  # PON 0/1/3
            cae, causa = t - timedelta(minutes=40, seconds=b["k"] * 3), "LOS"
        elif b["nap"] == 8 and b["k"] == 1:
            cae, causa = t - timedelta(days=2), "dying-gasp"
        elif b["nap"] == 9 and b["k"] == 0:
            cae, causa = t - timedelta(hours=5), "dying-gasp"
        clave = f"{b['slot']}/{b['port']}"
        if clave in caidos:
            cae, causa = caidos[clave], "LOS"
        if cae is not None:
            o.update(run_state="offline", rx_power_dbm=None, tx_power_dbm=None, rx_status=None,
                     last_seen=iso(cae), last_down_time=iso(cae), last_down_cause=causa)
        out.append(o)
    return out


def serie(ont_id, horas, cubos):
    b = next((x for x in BASE_ONTS if x["id"] == ont_id), None)
    if b is None:
        return None
    t = ahora()
    paso = horas * 3600 / cubos
    baja = -0.6 if b["nap"] == 2 else -0.02  # dB por semana
    puntos = []
    for i in range(cubos):
        cuando = t - timedelta(seconds=paso * (cubos - i))
        semanas = (cubos - i) * paso / 604800
        rx = b["rx"] - baja * semanas + 0.15 * ((i * 7) % 5 - 2) / 2
        puntos.append({"t": iso(cuando), "rx_avg": f"{rx:.2f}", "rx_min": f"{rx - 0.2:.2f}", "rx_max": f"{rx + 0.2:.2f}",
                       "samples": 30})
    return {"bucket_seconds": round(paso), "points": puntos, "trend": {
        "samples": cubos * 30, "rx_db_per_week": baja, "rx_min": f"{b['rx'] - 0.4:.2f}", "rx_max": f"{b['rx'] + 0.6:.2f}",
        "rx_avg": f"{b['rx'] + 0.1:.2f}", "first_at": iso(t - timedelta(hours=horas)), "last_at": iso(t)}}


OPENAPI = {"openapi": "3.1.0", "info": {"title": "SmartOLT libre", "version": "0.9"}, "paths": {
    "/api/olts": {"get": {"summary": "Lista de OLTs"}},
    "/api/olts/{olt_id}": {"get": {"summary": "Una OLT", "parameters": [{"name": "olt_id", "in": "path", "required": True, "schema": {"type": "integer"}}]}},
    "/api/olts/{olt_id}/onts": {"get": {"summary": "ONTs de una OLT", "parameters": [
        {"name": "olt_id", "in": "path", "required": True, "schema": {"type": "integer"}},
        {"name": "limit", "in": "query", "schema": {"type": "integer", "default": 200}},
        {"name": "offset", "in": "query", "schema": {"type": "integer", "default": 0}}]}},
    "/api/olts/{olt_id}/boards": {"get": {"summary": "Placas", "parameters": [{"name": "olt_id", "in": "path", "required": True, "schema": {"type": "integer"}}]}},
    "/api/olts/{olt_id}/uplinks": {"get": {"summary": "Uplinks con tráfico", "parameters": [{"name": "olt_id", "in": "path", "required": True, "schema": {"type": "integer"}}]}},
    "/api/olts/{olt_id}/ports/{slot}/{port}/series": {"get": {"summary": "Serie de un puerto PON", "parameters": [
        {"name": "olt_id", "in": "path", "required": True, "schema": {"type": "integer"}},
        {"name": "slot", "in": "path", "required": True, "schema": {"type": "integer"}},
        {"name": "port", "in": "path", "required": True, "schema": {"type": "integer"}}]}},
    "/api/onts/{ont_id}/series": {"get": {"summary": "Serie óptica", "parameters": [
        {"name": "ont_id", "in": "path", "required": True, "schema": {"type": "integer"}},
        {"name": "hours", "in": "query", "schema": {"type": "integer", "default": 168}},
        {"name": "buckets", "in": "query", "schema": {"type": "integer", "default": 120}}]}},
    "/api/onts/{ont_id}/events": {"get": {"summary": "Eventos", "parameters": [{"name": "ont_id", "in": "path", "required": True, "schema": {"type": "integer"}}]}},
    "/api/onts/{ont_id}/live": {"get": {"summary": "Lectura en vivo por SSH", "parameters": [{"name": "ont_id", "in": "path", "required": True, "schema": {"type": "integer"}}]}},
    "/api/onts/{ont_id}/actions/reboot": {"post": {"summary": "Reiniciar la ONT", "parameters": [{"name": "ont_id", "in": "path", "required": True, "schema": {"type": "integer"}}],
                                                   "requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Confirmar"}}}}}},
    "/api/thresholds": {"get": {"summary": "Umbrales"}},
}, "components": {"schemas": {"Confirmar": {"type": "object", "properties": {"confirm": {"type": "boolean"}, "dry_run": {"type": "boolean"}}}}}}

pedidos = []  # (método, ruta) de lo que se le pidió al panel, para comprobar que no se toca lo que no se debe


def panel(path, q, method="GET"):
    pedidos.append((method, path))
    if path == "/_pedidos":
        return 200, [list(p) for p in pedidos[:-1]]
    if path == "/_control":
        with candado:
            for clave in q.get("caer", []):
                estado["caidos"]["/".join(clave.split("/")[-2:])] = ahora()
            for clave in q.get("volver", []):
                estado["caidos"].pop("/".join(clave.split("/")[-2:]), None)
            if "atraso" in q:
                estado["atraso"] = int(q["atraso"][0])
            return 200, {"caidos": sorted(estado["caidos"]), "atraso": estado["atraso"]}
    if path == "/openapi.json":
        return 200, OPENAPI
    if path == "/api/olts":
        return 200, [{"id": 1, "name": "ALVATIC-MA5800-01", "ont_count": len(BASE_ONTS), "snmp_community": "no-mostrar",
                      "host": "10.0.0.1", "vendor": "huawei", "model": "MA5800-X17"},
                     {"id": 1362, "name": "ONSYS-MA5800-01", "ont_count": 1}]
    if path == "/api/olts/1":
        return 200, {"id": 1, "name": "ALVATIC-MA5800-01", "uptime_s": 8640000, "temperature_c": 41}
    if path == "/api/olts/1/onts":
        desde = int(q.get("offset", ["0"])[0])
        return 200, onts_ahora()[desde:desde + int(q.get("limit", ["500"])[0])]
    if path == "/api/olts/1362/onts":
        return 200, [{"id": 5000, "slot": 1, "port": 0, "ont_id": 0, "sn": BASE_ONTS[0]["sn"],
                      "description": "#1001 De otra empresa", "run_state": "online", "rx_power_dbm": "-30.00",
                      "last_seen": iso(ahora())}]
    if path == "/api/olts/1/boards":
        return 200, [{"slot": 1, "type": "H901GPSF", "ports": 16, "status": "Normal"},
                     {"slot": 2, "type": "H901GPSF", "ports": 16, "status": "Normal"}]
    if path == "/api/olts/1/uplinks":
        return 200, [{"slot": 9, "port": 0, "name": "10GE 0/9/0", "rx_bps": 152000000, "tx_bps": 31000000}]
    if path == "/api/thresholds":
        return 200, {"gpon": {"warn": -25.0, "crit": -28.0, "high": -8.0}}
    partes = path.strip("/").split("/")
    if len(partes) == 7 and partes[:2] == ["api", "olts"] and partes[3] == "ports" and partes[6] == "series":
        return 200, {"bucket_seconds": 3600, "points": [{"t": iso(ahora()), "online": 12, "rx_avg": "-21.4"}]}
    if len(partes) == 4 and partes[:2] == ["api", "onts"] and partes[2].isdigit():
        ont_id = int(partes[2])
        if partes[3] == "series":
            s = serie(ont_id, int(q.get("hours", ["168"])[0]), min(200, int(q.get("buckets", ["42"])[0])))
            return (200, s) if s else (404, {"detail": "Not Found"})
        if partes[3] == "events":
            o = next((x for x in onts_ahora() if x["id"] == ont_id), None)
            if o is None:
                return 404, {"detail": "Not Found"}
            ev = [{"occurred_at": iso(ahora() - timedelta(days=90)), "event_type": "appeared",
                   "details": {"fsp": f"0/{o['slot']}/{o['port']}"}}]
            if o["run_state"] == "offline":
                ev.insert(0, {"occurred_at": o["last_down_time"], "event_type": "offline",
                              "details": {"cause": o["last_down_cause"]}})
            return 200, ev
        if partes[3] == "live":
            return 200, {"aviso": "esto abre una sesión SSH: las muestras no tienen que pedirlo"}
    return 404, {"detail": "Not Found"}


def wispro(path, q, headers):
    if headers.get("Authorization") != TOKEN:
        return 200, {"status": 401, "meta": {}, "message": "Unauthorized", "errors": {}}
    colecciones = {"/naps": (NAPS, "nap"), "/contracts": (CONTRATOS, "contract"), "/clients": (CLIENTES, "client"),
                   "/olts": ([{"id": U(900), "name": "HUAWEI"}], "olt")}
    if path in colecciones:
        items, objeto = colecciones[path]
        pagina = int(q.get("page", ["1"])[0])
        por = min(int(q.get("per_page", ["20"])[0]), 1000)
        total = max(1, -(-len(items) // por))
        return 200, {"status": 200, "meta": {"object": objeto, "pagination": {
            "total_records": len(items), "total_pages": total, "per_page": por, "current_page": pagina}},
            "data": items[(pagina - 1) * por:pagina * por]}
    partes = path.strip("/").split("/")
    if len(partes) == 3 and partes[0] == "contracts" and partes[2] == "status_ont":
        c = next((x for x in CONTRATOS if x["id"] == partes[1]), None)
        if c is None or not c["ont_serial_number"]:
            return 200, {"status": 400, "meta": {}, "message": "Invalid record", "errors": {"base": ["Ont no puede estar en blanco"]}}
        n = int(partes[1][-12:]) - 2000
        b = next(x for x in BASE_ONTS if x["id"] == 100 + n)
        return 200, {"olt": {"ont_interface": f"0/{b['slot']}/{b['port']}:{b['ont_id']}", "serial_number": b["sn"],
                             "rx_power": f"{b['rx'] + 0.3:.2f}", "tx_power": "2.27", "temperature": "47",
                             "status_rx_power": "ok"}}
    return 200, {"status": 404, "meta": {}, "message": "Not found", "errors": {}}


def servidor(puerto, fn, con_cabeceras):
    class H(BaseHTTPRequestHandler):
        def responder(self, method):
            u = urlsplit(self.path)
            q = parse_qs(u.query)
            status, body = fn(u.path, q, self.headers) if con_cabeceras else fn(u.path, q, method)
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.responder("GET")

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self.responder("POST")

        def log_message(self, *a):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", puerto), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


if __name__ == "__main__":
    servidor(18091, wispro, True)
    servidor(18092, panel, False)
    print("Wispro falso en 18091, panel falso en 18092", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        sys.exit(0)
