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
             "tx_power_dbm": "2.31", "last_seen": visto, "technology": "gpon", "vendor": "HWTC", "ont_type": None,
             "distance_m": None, "last_up_time": None, "last_down_time": None, "last_down_cause": None,
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


def _ruta(resumen, *params, cuerpo=None, descripcion=None):
    op = {"summary": resumen, "parameters": [
        {"name": n, "in": "path" if n in ("olt_id", "ont_ref", "slot", "port", "if_ref") else "query",
         **({"required": True} if n in ("olt_id", "ont_ref", "slot", "port", "if_ref", "q") else {}),
         "schema": {"type": "integer", **({"default": d} if d is not None else {})}} for n, d in params]}
    if descripcion:
        op["description"] = descripcion
    if cuerpo:
        op["requestBody"] = {"content": {"application/json": {"schema": {"$ref": f"#/components/schemas/{cuerpo}"}}}}
    return op


# Las rutas del panel de verdad (OLT Panel API 1.0), como las mostró herramientas/muestras-panel.py el 13/11/2026.
OPENAPI = {"openapi": "3.1.0", "info": {"title": "OLT Panel API", "version": "1.0"}, "paths": {
    "/api/health": {"get": _ruta("Health")},
    "/api/olts": {"get": _ruta("Olts")},
    "/api/olts/{olt_id}": {"get": _ruta("Olt", ("olt_id", None))},
    "/api/olts/{olt_id}/chassis": {"get": _ruta("Chassis", ("olt_id", None))},
    "/api/olts/{olt_id}/summary": {"get": _ruta("Summary", ("olt_id", None))},
    "/api/olts/{olt_id}/onts": {"get": _ruta("Onts", ("olt_id", None), ("slot", None), ("port", None), ("state", None),
                                             ("search", None), ("limit", 500), ("offset", 0))},
    "/api/onts/{ont_ref}": {"get": _ruta("Ont", ("ont_ref", None))},
    "/api/onts/{ont_ref}/optical": {"get": _ruta("Ont Optical", ("ont_ref", None), ("hours", 168))},
    "/api/olts/{olt_id}/ports/{slot}/{port}/series": {"get": _ruta("Port Series", ("olt_id", None), ("slot", None), ("port", None),
                                                                  ("hours", 168), ("buckets", 300))},
    "/api/onts/{ont_ref}/series": {"get": _ruta("Ont Series", ("ont_ref", None), ("hours", 168), ("buckets", 300))},
    "/api/onts/{ont_ref}/events": {"get": _ruta("Ont Events", ("ont_ref", None), ("limit", 50))},
    "/api/olts/{olt_id}/profiles": {"get": _ruta("Profiles", ("olt_id", None))},
    "/api/olts/{olt_id}/autofind": {"get": _ruta("Autofind", ("olt_id", None), descripcion="ONTs sin autorizar, leídas por SSH en vivo.")},
    "/api/olts/{olt_id}/actions/authorize": {"post": _ruta("Action Authorize", ("olt_id", None), cuerpo="AuthorizeBody")},
    "/api/onts/{ont_ref}/actions/reboot": {"post": _ruta("Action Reboot", ("ont_ref", None), cuerpo="OntActionBody")},
    "/api/onts/{ont_ref}/actions/deauthorize": {"post": _ruta("Action Deauthorize", ("ont_ref", None), cuerpo="OntActionBody")},
    "/api/diagnostics": {"get": _ruta("Diagnostics Catalog")},
    "/api/onts/{ont_ref}/diagnostic": {"post": _ruta("Ont Diagnostic", ("ont_ref", None), cuerpo="DiagnosticBody")},
    "/api/onts/{ont_ref}/traffic": {"get": _ruta("Ont Traffic", ("ont_ref", None), ("hours", 168), descripcion="Tráfico medido por SSH (watch).")},
    "/api/onts/{ont_ref}/watch": {"post": _ruta("Ont Watch", ("ont_ref", None), cuerpo="WatchBody")},
    "/api/olts/{olt_id}/ports/{slot}/{port}/traffic": {"get": _ruta("Port Traffic", ("olt_id", None), ("slot", None), ("port", None),
                                                                   ("hours", 24), ("buckets", 300))},
    "/api/olts/{olt_id}/interfaces": {"get": _ruta("Interfaces", ("olt_id", None), ("uplinks_only", None))},
    "/api/interfaces/{if_ref}/series": {"get": _ruta("Interface Series", ("if_ref", None), ("hours", 24), ("buckets", 300))},
    "/api/olts/{olt_id}/refresh": {"post": _ruta("Refresh Onts", ("olt_id", None))},
    "/api/olts/{olt_id}/boards/refresh": {"post": _ruta("Refresh Boards", ("olt_id", None))},
    "/api/olts/{olt_id}/boards": {"get": _ruta("Boards Detail", ("olt_id", None))},
    "/api/search": {"get": _ruta("Search", ("q", None), ("olt_id", None), ("limit", 30))},
    "/api/thresholds": {"get": _ruta("Thresholds")},
    "/api/audit": {"get": _ruta("Audit", ("limit", 100), descripcion="Bitácora de acciones y comandos.")},
}, "components": {"schemas": {
    "AuthorizeBody": {"type": "object", "properties": {"slot": {"type": "integer"}, "port": {"type": "integer"}, "sn": {"type": "string"},
                                                       "execute": {"type": "boolean"}, "confirm": {"type": "boolean"}}},
    "OntActionBody": {"type": "object", "properties": {"execute": {"type": "boolean"}, "confirm": {"type": "boolean"}}},
    "DiagnosticBody": {"type": "object", "properties": {"command": {"type": "string"}}},
    "WatchBody": {"type": "object", "properties": {"watching": {"type": "boolean"}}}}}}

pedidos = []  # (método, ruta) de lo que se le pidió al panel, para comprobar que no se toca lo que no se debe
PUERTOS = sorted({(1, 0), (1, 1), (1, 2), (1, 3), (2, 0)})


def _olt(con_cuentas=True):
    o = {"id": 1, "name": "ALVATIC-MA5800-01", "model": "MA5800-X17", "firmware": None, "host": "10.0.0.1", "enabled": True,
         "last_poll_at": iso(ahora() - timedelta(seconds=45 + estado["atraso"])), "last_error": None, "last_error_at": None}
    if con_cuentas:
        onts = onts_ahora()
        o.update(ont_count=len(onts), ont_online=sum(1 for x in onts if x["run_state"] == "online"))
    return o


def _interfaces():
    """Los uplinks (placa 9) y los puertos PON, con su tráfico: como /api/olts/N/interfaces."""
    t = iso(ahora())
    out = [{"id": 1, "if_index": 234954752, "if_name": "ethernet0/9/0", "slot": 9, "port": 0, "speed_mbps": 10000,
            "admin_status": "up", "oper_status": "up", "is_uplink": True, "last_seen": t, "in_bps": 1153039023,
            "out_bps": 100470145, "in_octets": 931012373793951, "out_octets": 88654309487240, "sampled_at": t},
           {"id": 2, "if_index": 234954816, "if_name": "ethernet0/9/1", "slot": 9, "port": 1, "speed_mbps": 10000,
            "admin_status": "up", "oper_status": "down", "is_uplink": True, "last_seen": t, "in_bps": 0, "out_bps": 0,
            "in_octets": 0, "out_octets": 0, "sampled_at": t}]
    onts = onts_ahora()
    for n, (slot, port) in enumerate(PUERTOS):
        en_linea = sum(1 for o in onts if (o["slot"], o["port"]) == (slot, port) and o["run_state"] == "online")
        out.append({"id": 10 + n, "if_index": 4194304000 + slot * 8192 + port * 256, "if_name": f"GPON 0/{slot}/{port}",
                    "slot": slot, "port": port, "speed_mbps": 2500, "admin_status": "up",
                    "oper_status": "up" if en_linea else "down", "is_uplink": False, "last_seen": t,
                    "in_bps": en_linea * 900_000, "out_bps": en_linea * 8_500_000, "in_octets": 10 ** 12 + n,
                    "out_octets": 10 ** 13 + n, "sampled_at": t})
    return out


def _serie_trafico(horas, cubos):
    paso = horas * 3600 / cubos
    return {"bucket_seconds": round(paso), "points": [
        {"t": iso(ahora() - timedelta(seconds=paso * (cubos - i))), "in_bps": 9_000_000 + i * 1000, "out_bps": 85_000_000 + i * 9000}
        for i in range(cubos)]}


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
    if method != "GET":
        return 200, {"aviso": "esto cambia algo: ni traza ni las muestras tienen que pedirlo"}
    cubos = int(q.get("buckets", ["300"])[0])
    if cubos < 20:  # como el panel de verdad
        return 422, {"detail": [{"type": "greater_than_equal", "loc": ["query", "buckets"],
                                 "msg": "Input should be greater than or equal to 20", "input": str(cubos), "ctx": {"ge": 20}}]}
    if path == "/openapi.json":
        return 200, OPENAPI
    if path == "/api/health":
        return 200, {"status": "ok"}
    if path == "/api/olts":
        return 200, [_olt(), {"id": 1362, "name": "ONSYS-MA5800-01", "model": "MA5800-X17", "firmware": None, "host": "203.0.113.9",
                              "enabled": True, "last_poll_at": iso(ahora()), "last_error": None, "last_error_at": None,
                              "ont_count": 1, "ont_online": 1}]
    if path == "/api/olts/1":
        return 200, _olt(con_cuentas=False)
    if path == "/api/olts/1/onts":
        desde = int(q.get("offset", ["0"])[0])
        return 200, onts_ahora()[desde:desde + int(q.get("limit", ["500"])[0])]
    if path == "/api/olts/1362/onts":
        return 200, [{"id": 5000, "slot": 1, "port": 0, "ont_id": 0, "sn": BASE_ONTS[0]["sn"],
                      "description": "#1001 De otra empresa", "run_state": "online", "rx_power_dbm": "-30.00",
                      "last_seen": iso(ahora())}]
    if path == "/api/olts/1/summary":
        onts = onts_ahora()
        return 200, {"total": len(onts), "online": sum(1 for o in onts if o["run_state"] == "online"),
                     "offline": sum(1 for o in onts if o["run_state"] != "online"), "worst_rx": []}
    if path == "/api/olts/1/boards":
        return 200, [{"slot_id": s, "board_name": n, "status": "Normal" if r == "service" else "Active_normal", "role": r,
                      "technology": "gpon" if r == "service" else None,
                      "details": {"powered": True, "board_name": n, "board_status": "Normal"}, "updated_at": iso(ahora())}
                     for s, n, r in ((1, "H901GPSF", "service"), (2, "H901GPSF", "service"), (9, "H903MPLA", "control"))]
    if path == "/api/olts/1/chassis":
        return 200, {"olt_id": 1, "boards": [{"slot_id": 0, "board_name": None, "status": None, "role": None, "technology": None, "ports": []}] + [
            {"slot_id": s, "board_name": "H901GPSF", "status": "Normal", "role": "service", "technology": "gpon",
             "ports": [{"port": p, "ont_total": sum(1 for b in BASE_ONTS if (b["slot"], b["port"]) == (s, p))} for p in range(16)]}
            for s in (1, 2)]}
    if path == "/api/olts/1/interfaces":
        return 200, _interfaces()
    if path in ("/api/olts/1/profiles", "/api/olts/1/autofind"):
        time.sleep(3)  # en el panel de verdad abre una sesión en la OLT: nadie tiene que pedirlo
        return 200, []
    if path == "/api/thresholds":
        return 200, {"gpon": {"warn": -25.0, "crit": -28.0, "high": -8.0}, "xgpon": {"warn": -24.0, "crit": -28.0, "high": -8.0}}
    partes = path.strip("/").split("/")
    horas = int(q.get("hours", ["168"])[0])
    if len(partes) == 7 and partes[:2] == ["api", "olts"] and partes[3] == "ports" and partes[6] == "series":
        return 200, {"bucket_seconds": 3600, "points": [{"t": iso(ahora()), "online": 12, "rx_avg": "-21.4"}]}
    if len(partes) == 7 and partes[:2] == ["api", "olts"] and partes[3] == "ports" and partes[6] == "traffic":
        return 200, _serie_trafico(horas, min(cubos, 60))
    if len(partes) == 4 and partes[:2] == ["api", "interfaces"] and partes[3] == "series":
        return 200, _serie_trafico(horas, min(cubos, 60))
    if len(partes) == 3 and partes[:2] == ["api", "onts"] and partes[2].isdigit():
        o = next((x for x in onts_ahora() if x["id"] == int(partes[2])), None)
        return (200, {**o, "olt_id": 1, "frame": 0, "olt_name": "ALVATIC-MA5800-01", "olt_host": "10.0.0.1"}) if o else (404, {"detail": "Not Found"})
    if len(partes) == 4 and partes[:2] == ["api", "onts"] and partes[2].isdigit():
        ont_id = int(partes[2])
        if partes[3] == "series":
            s = serie(ont_id, horas, min(200, cubos))
            return (200, s) if s else (404, {"detail": "Not Found"})
        if partes[3] == "optical":
            s = serie(ont_id, horas, min(300, horas * 12))
            if not s:
                return 404, {"detail": "Not Found"}
            return 200, [{"sampled_at": p["t"], "rx_power_dbm": p["rx_avg"], "tx_power_dbm": "2.26", "temperature_c": "40.0",
                          "voltage_v": "3.36", "bias_ma": None} for p in s["points"]]
        if partes[3] == "events":
            o = next((x for x in onts_ahora() if x["id"] == ont_id), None)
            if o is None:
                return 404, {"detail": "Not Found"}
            ev = [{"occurred_at": iso(ahora() - timedelta(days=90)), "event_type": "appeared",
                   "details": {"fsp": f"0/{o['slot']}/{o['port']}", "via": "snmp_poll", "ont_id": o["ont_id"]}}]
            if o["run_state"] == "offline":
                ev.insert(0, {"occurred_at": o["last_down_time"], "event_type": "offline",
                              "details": {"cause": o["last_down_cause"]}})
            return 200, ev
        if partes[3] == "traffic":
            return 200, {"aviso": "tráfico por SSH: las muestras no tienen que pedirlo"}
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
