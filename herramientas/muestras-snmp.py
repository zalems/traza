#!/usr/bin/env python3
"""Lee por SNMP, directo de la OLT, lo que sirve para saber cómo responde ese equipo:
qué placa dice tener en cada slot, la óptica de cada puerto PON (potencia de salida
del SFP, temperatura, corriente y tensión) y el tráfico de cada puerto medido con
los tres contadores que puede tener (los estándar de 64 y de 32 bits y los de
Huawei para los puertos GPON), para ver cuáles se mueven. Y muestra las primeras
filas de cada tabla que traza lee de una OLT cargada en el visor (ONT, potencias),
con cuánto tarda cada una. No muestra números de serie enteros ni descripciones.

Sirve para comparar con lo que dice la OLT si algo no coincide, y para comprobar
que desde este servidor se llega a la OLT por SNMP. Solo lee (GET y GETBULK de SNMP
v2c): no cambia nada en la OLT. No necesita nada instalado (habla SNMP por su cuenta).

Uso, en el servidor de traza:
    python3 herramientas/muestras-snmp.py --red 2               # la OLT cargada en traza para esa red (como root)
    python3 herramientas/muestras-snmp.py --olt 1               # toma la dirección de la OLT 1 del panel
    python3 herramientas/muestras-snmp.py --host 192.0.2.10     # o se indica la dirección (y --puerto si no es 161)

Con --red se usa la conexión guardada en traza (la dirección y la comunidad no se
muestran). Con --olt o --host la community se escribe sin que se vea y no se guarda.
"""

import argparse
import getpass
import json
import socket
import sys
import time
import urllib.request

SISTEMA = {"descripción": "1.3.6.1.2.1.1.1.0", "nombre": "1.3.6.1.2.1.1.5.0", "encendida hace": "1.3.6.1.2.1.1.3.0"}
NOMBRE_IF = "1.3.6.1.2.1.31.1.1.1.1"  # IF-MIB ifName
ESTADO_IF = "1.3.6.1.2.1.2.2.1.8"  # IF-MIB ifOperStatus (1 = arriba, 2 = abajo)
ENTRA_IF = "1.3.6.1.2.1.31.1.1.1.6"  # IF-MIB ifHCInOctets
SALE_IF = "1.3.6.1.2.1.31.1.1.1.10"  # IF-MIB ifHCOutOctets
ENTRA_IF32 = "1.3.6.1.2.1.2.2.1.10"  # IF-MIB ifInOctets (32 bits)
SALE_IF32 = "1.3.6.1.2.1.2.2.1.16"  # IF-MIB ifOutOctets
VELOCIDAD_IF = "1.3.6.1.2.1.31.1.1.1.15"  # IF-MIB ifHighSpeed (Mb/s)
# HUAWEI-XPON-MIB hwGponOltEthernetStatisticTable, por ifIndex: 15 = octetos recibidos, 30 = enviados.
TRAFICO_PON = "1.3.6.1.4.1.2011.6.128.1.1.4.21.1"
# De dónde puede salir el tráfico de un puerto: (cómo se le dice, contador de lo que entra, de lo que sale, solo puertos PON).
CONTADORES = [("64 bits", ENTRA_IF, SALE_IF, False), ("32 bits", ENTRA_IF32, SALE_IF32, False),
              ("Huawei", TRAFICO_PON + ".15", TRAFICO_PON + ".30", True)]
# HUAWEI-XPON-MIB hwGponOltOpticsDdmInfoTable: la óptica de cada puerto PON, por ifIndex.
OPTICA = "1.3.6.1.4.1.2011.6.128.1.1.2.23.1"
COLUMNAS = {1: "temperatura", 2: "tension", 3: "corriente", 4: "tx", 5: "rx"}
SIN_DATO = 2147483647  # lo que Huawei devuelve cuando no hay lectura
GPON = 0xFA000000  # los ifIndex de los puertos GPON de Huawei empiezan acá (tipo 125)
SLOT = "1.3.6.1.4.1.2011.6.3.3.2.1"  # HUAWEI-DEVICE-MIB hwSlotTable (marco.slot)
XPON = "1.3.6.1.4.1.2011.6.128.1.1.2"  # HUAWEI-XPON-MIB
# Lo que traza lee de una OLT cargada en el visor: (qué es, columna, cómo se muestra, cuántas filas se piden).
# De cada slot (hwSlotTable, por marco.slot): qué columna se lee y cómo se la rotula. No se leen ni el
# número de serie de la placa (11) ni la clave de su BIOS (26).
PLACAS = [(21, "nombre"), (28, "configurada"), (29, "básica"), (2, "tipo"), (8, "estado"), (22, "estado 1º"), (6, "modo"), (13, "°C"),
          (3, "descripción")]
ESTADOS_PLACA = {1: "sin placa", 2: "normal", 3: "falla", 4: "prohibida", 5: "detectada", 6: "configurándose", 7: "ausente", 8: "anormal",
                 9: "versión", 10: "cargando", 11: "fuera de servicio", 17: "no coincide"}
TABLAS = [
    ("puertos PON: octetos recibidos (tabla de Huawei)", TRAFICO_PON + ".15", "texto", 300),
    ("puertos PON: octetos enviados (tabla de Huawei)", TRAFICO_PON + ".30", "texto", 300),
    ("ONT: número de serie", XPON + ".43.1.3", "serie", 5000),
    ("ONT: descripción", XPON + ".43.1.9", "privado", 5000),
    ("ONT: estado (1 en línea, 2 no)", XPON + ".46.1.15", "texto", 5000),
    ("ONT: distancia (m)", XPON + ".46.1.20", "texto", 5000),
    ("ONT: última caída (fecha)", XPON + ".46.1.23", "texto", 5000),
    ("ONT: causa de la última caída", XPON + ".46.1.24", "texto", 5000),
    ("ONT: potencia que recibe (0,01 dBm)", XPON + ".51.1.4", "texto", 60),  # pocas: la OLT se la pregunta a cada ONT
]


# ------------------------------------------------------------------ SNMP v2c

def _largo(n):
    if n < 0x80:
        return bytes([n])
    cuerpo = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(cuerpo)]) + cuerpo


def _tlv(tipo, contenido):
    return bytes([tipo]) + _largo(len(contenido)) + contenido


def _entero(n):
    return _tlv(0x02, n.to_bytes(n.bit_length() // 8 + 1, "big", signed=True))


def _oid(texto):
    partes = [int(x) for x in texto.strip(".").split(".")]
    out = bytearray([partes[0] * 40 + partes[1]])
    for p in partes[2:]:
        trozo = [p & 0x7F]
        p >>= 7
        while p:
            trozo.append(0x80 | (p & 0x7F))
            p >>= 7
        out.extend(reversed(trozo))
    return _tlv(0x06, bytes(out))


def _leer(data, pos):
    """Un elemento BER: (tipo, contenido, posición siguiente)."""
    tipo = data[pos]
    largo = data[pos + 1]
    pos += 2
    if largo & 0x80:
        n = largo & 0x7F
        largo = int.from_bytes(data[pos:pos + n], "big")
        pos += n
    if pos + largo > len(data):
        raise ValueError("respuesta cortada")
    return tipo, data[pos:pos + largo], pos + largo


def _oid_texto(contenido):
    partes = [contenido[0] // 40, contenido[0] % 40]
    n = 0
    for b in contenido[1:]:
        n = (n << 7) | (b & 0x7F)
        if not b & 0x80:
            partes.append(n)
            n = 0
    return ".".join(map(str, partes))


def _valor(tipo, contenido):
    if tipo == 0x02:
        return int.from_bytes(contenido, "big", signed=True)
    if tipo in (0x41, 0x42, 0x43, 0x46, 0x47):  # Counter32, Gauge32, TimeTicks, Counter64, Unsigned32
        return int.from_bytes(contenido, "big")
    if tipo == 0x04:
        try:
            texto = contenido.decode("utf-8")
            return texto if texto.isprintable() or not texto else contenido.hex()
        except UnicodeDecodeError:
            return contenido.hex()
    if tipo == 0x06:
        return _oid_texto(contenido)
    if tipo == 0x40:
        return ".".join(str(b) for b in contenido)
    return None  # NULL, noSuchObject (0x80), noSuchInstance (0x81), endOfMibView (0x82)


class SinRespuesta(Exception):
    pass


class Snmp:
    """Un cliente mínimo de SNMP v2c, solo para leer."""

    def __init__(self, host, puerto, community, espera=3.0, intentos=2):
        self.destino, self.community, self.intentos = (host, puerto), community.encode(), intentos
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.settimeout(espera)
        self.sock.connect(self.destino)
        self.pedido = int(time.time()) & 0xFFFF
        self.pedidos = 0

    def desde(self):
        return self.sock.getsockname()[0]

    def _pedir(self, tipo, oids, no_rep=0, max_rep=0):
        self.pedido = (self.pedido + 1) & 0x7FFFFFFF
        enlaces = _tlv(0x30, b"".join(_tlv(0x30, _oid(o) + _tlv(0x05, b"")) for o in oids))
        pdu = _tlv(tipo, _entero(self.pedido) + _entero(no_rep) + _entero(max_rep) + enlaces)
        mensaje = _tlv(0x30, _entero(1) + _tlv(0x04, self.community) + pdu)
        for _ in range(self.intentos):
            self.sock.send(mensaje)
            self.pedidos += 1
            fin = time.monotonic() + self.sock.gettimeout()
            while time.monotonic() < fin:
                try:
                    data = self.sock.recv(65535)
                except (socket.timeout, ConnectionRefusedError):
                    break
                try:
                    _, cuerpo, _ = _leer(data, 0)
                    _, _, pos = _leer(cuerpo, 0)  # versión
                    _, _, pos = _leer(cuerpo, pos)  # community
                    tipo_resp, pdu_resp, _ = _leer(cuerpo, pos)
                    _, rid, pos = _leer(pdu_resp, 0)
                    if tipo_resp != 0xA2 or int.from_bytes(rid, "big", signed=True) != self.pedido:
                        continue  # una respuesta vieja
                    _, estado, pos = _leer(pdu_resp, pos)
                    _, _, pos = _leer(pdu_resp, pos)
                    _, lista, _ = _leer(pdu_resp, pos)
                    if int.from_bytes(estado, "big"):
                        raise SinRespuesta(f"la OLT respondió con el error SNMP {int.from_bytes(estado, 'big')}")
                    out, pos = [], 0
                    while pos < len(lista):
                        _, enlace, pos = _leer(lista, pos)
                        _, oid, p2 = _leer(enlace, 0)
                        tipo_valor, contenido, _ = _leer(enlace, p2)
                        out.append((_oid_texto(oid), tipo_valor, _valor(tipo_valor, contenido)))
                    return out
                except (ValueError, IndexError):
                    continue  # algo que no es una respuesta SNMP entera
        raise SinRespuesta("no respondió")

    def get(self, oids):
        """{oid: valor} de varios objetos (None si la OLT no tiene alguno)."""
        out = {}
        for i in range(0, len(oids), 20):
            for oid, tipo, valor in self._pedir(0xA0, oids[i:i + 20]):
                out[oid] = None if tipo in (0x05, 0x80, 0x81, 0x82) else valor
        return out

    def recorrer(self, base, limite=400):
        """[(índice, valor)] de una columna, con GETBULK, hasta `limite` filas."""
        out, actual = [], base
        while len(out) < limite:
            filas = self._pedir(0xA5, [actual], 0, 20)
            if not filas:
                break
            for oid, tipo, valor in filas:
                if not oid.startswith(base + ".") or tipo == 0x82 or len(out) >= limite:
                    return out
                out.append((oid[len(base) + 1:], valor))
            if filas[-1][0] == actual:
                break
            actual = filas[-1][0]
        return out


# ----------------------------------------------------------------- muestras

def puerto_gpon(indice):
    """El ifIndex de un puerto GPON de Huawei en 'marco/placa/puerto' (si tiene esa forma)."""
    if indice & 0xFE000000 != GPON:
        return None
    resto = indice - GPON
    return f"{resto >> 19 & 0x3F}/{resto >> 13 & 0x3F}/{resto >> 8 & 0x1F}"


def host_del_panel(panel, olt):
    try:
        with urllib.request.urlopen(f"{panel.rstrip('/')}/api/olts/{olt}", timeout=10) as r:
            dato = json.loads(r.read())
    except Exception as e:  # sin conexión, 404, no es JSON
        raise SystemExit(f"No pude leer la OLT {olt} del panel ({panel}): {e}. Indicá su dirección con --host.")
    host = str(dato.get("host") or "").strip()
    if not host:
        raise SystemExit(f"El panel no dice la dirección de la OLT {olt}. Indicala con --host.")
    return host, dato.get("model")


def olt_de_traza(config, red, cual):
    """(dirección, puerto, community, nombre) de una OLT cargada en traza para esa red."""
    try:
        with open(config, encoding="utf-8") as f:
            data = json.load(f)
    except PermissionError:
        raise SystemExit(f"No se puede leer {config}: corré la herramienta como root.") from None
    except (OSError, ValueError) as e:
        raise SystemExit(f"No se pudo leer {config}: {e}") from None
    olts = [e for e in ((data.get("redes") or {}).get(str(red)) or {}).get("olts") or [] if isinstance(e, dict)]
    if not olts:
        raise SystemExit(f"La red {red} no tiene una OLT cargada en traza (se cargan en el tablero de la OLT, pestaña Equipos).")
    if cual is None and len(olts) > 1:
        lista = "; ".join(f"{n}: {e.get('nombre')}" for n, e in enumerate(olts, 1))
        raise SystemExit(f"La red {red} tiene {len(olts)} OLT cargadas ({lista}). Elegí una con --cual N.")
    if cual is not None and not 1 <= cual <= len(olts):
        raise SystemExit(f"--cual va de 1 a {len(olts)}.")
    e = olts[(cual or 1) - 1]
    snmp = e.get("snmp") or {}
    if not e.get("host") or not snmp.get("community"):
        raise SystemExit(f"A la OLT «{e.get('nombre')}» le falta la dirección o la comunidad: completala en su «Conexión».")
    return e["host"], int(snmp.get("puerto") or 161), snmp["community"], str(e.get("nombre") or "")


def clase_de_puerto(nombre):
    """'pon' o 'eth' según cómo se llama la interfaz ('GPON 0/13/0', 'ethernet0/17/0'); None si no es un puerto de placa."""
    n = str(nombre or "").strip().lower()
    if not any(c.isdigit() for c in n) or n.count("/") != 2:
        return None
    return "pon" if "pon" in n else "eth" if n.startswith(("eth", "ge", "xge", "10ge")) else None


def ritmo(antes, despues, lapso):
    """Cómo se escribe lo que pasó entre dos lecturas de un contador de octetos: Mb/s, 'quieto' o '—' (no está)."""
    if not isinstance(antes, int) or not isinstance(despues, int):
        return "—"
    if despues == antes:
        return "quieto"
    if despues < antes:
        return "volvió a 0"
    return numero(round((despues - antes) * 8 / lapso / 1e4), 100, 2)


def numero(v, divisor=1, decimales=1):
    if not isinstance(v, int) or v == SIN_DATO:
        return "—"
    return f"{v / divisor:.{decimales}f}".replace(".", ",")


def main():
    ap = argparse.ArgumentParser(description="Lee por SNMP la óptica y el tráfico de los puertos PON de una OLT Huawei (solo lectura).")
    ap.add_argument("--red", help="número de la red de traza: se usa la conexión de la OLT cargada en traza para esa red")
    ap.add_argument("--cual", type=int, help="con --red, cuál de sus OLT si tiene más de una (1, 2…)")
    ap.add_argument("--config", default="/srv/ftth/data/integraciones.json", help="el archivo de integraciones de traza (para --red)")
    ap.add_argument("--olt", help="número de la OLT en el panel: se toma de ahí su dirección")
    ap.add_argument("--panel", default="http://10.10.0.230:8080", help="dirección del panel de la OLT")
    ap.add_argument("--host", help="dirección de la OLT (si no se usa --red ni --olt)")
    ap.add_argument("--puerto", type=int, default=161, help="puerto SNMP de la OLT (por defecto 161)")
    ap.add_argument("--espera", type=float, default=3.0, help="segundos que se espera cada respuesta")
    ap.add_argument("--lapso", type=float, default=10.0, help="segundos entre las dos lecturas con que se mide el tráfico (por defecto 10)")
    args = ap.parse_args()
    if not args.host and not args.olt and not args.red:
        ap.error("indicá --red N (la OLT cargada en traza), --olt N (la toma del panel) o --host DIRECCIÓN")
    modelo = nombre = None
    if args.red:
        host, args.puerto, community, nombre = olt_de_traza(args.config, args.red, args.cual)
    else:
        host, modelo = (args.host, None) if args.host else host_del_panel(args.panel, args.olt)
        if not args.host and ":" in host and host.count(":") == 1:  # el panel la guarda como dirección:puerto
            host, puerto = host.rsplit(":", 1)
            args.puerto = int(puerto) if puerto.isdigit() else args.puerto
        try:
            community = getpass.getpass("Community SNMP de lectura de la OLT (no se ve al escribir): ").strip()
        except (EOFError, KeyboardInterrupt):
            community = ""
        if not community:
            print("Sin community no se puede leer.")
            return 1
    cual = f" «{nombre}» de la red {args.red}" if args.red else f" {args.olt}" if args.olt else ""
    print(f"######## SNMP a la OLT{cual}{f' ({modelo})' if modelo else ''}, puerto {args.puerto}")
    try:
        snmp = Snmp(host, args.puerto, community, args.espera)
    except OSError as e:
        print(f"No se pudo abrir la conexión: {e}")
        return 1
    inicio = time.monotonic()
    try:
        sistema = snmp.get(list(SISTEMA.values()))
    except SinRespuesta as e:
        print(f"La OLT {e} por SNMP desde este servidor ({snmp.desde()}).")
        print("Puede ser: la community no es esa; la OLT solo acepta SNMP de ciertas direcciones y esta no está\n"
              "(en Huawei: sysman ip-access snmp, con sysman firewall snmp prendido); el puerto no es ese; o un firewall en el medio.")
        return 1
    for rotulo, oid in SISTEMA.items():
        v = sistema.get(oid)
        if rotulo == "encendida hace" and isinstance(v, int):
            v = f"{v // 8640000} días, {v % 8640000 // 360000} h"
        print(f"{rotulo}: {str(v)[:160]}")
    print(f"(responde desde {snmp.desde()} en {time.monotonic() - inicio:.2f} s)")

    # --- qué dice la OLT de cada slot
    try:
        slots = {}
        for columna, rotulo in PLACAS:
            for indice, v in snmp.recorrer(f"{SLOT}.{columna}", 200):
                if v not in (None, ""):
                    slots.setdefault(indice, {})[rotulo] = ESTADOS_PLACA.get(v, v) if rotulo == "estado" else v
        print(f"\n== Placas (hwSlotTable): {len(slots)} slots con fila")
        orden = sorted(slots, key=lambda i: [int(x) if x.isdigit() else 0 for x in i.split(".")])
        for indice in orden:
            datos = slots[indice]
            partes = [f"{rotulo}: {str(datos[rotulo])[:40]}" for _, rotulo in PLACAS if rotulo in datos]
            print(f"  {indice.replace('.', '/'):6} {' · '.join(partes) or '(sin datos)'}")
        if not slots:
            print("La OLT no devolvió esa tabla.")
    except SinRespuesta as e:
        print(f"\nLa OLT {e} al leer las placas.")

    # --- los puertos de las placas, por su nombre
    puertos = {}
    try:
        for indice, v in snmp.recorrer(NOMBRE_IF, 6000):
            clase = clase_de_puerto(v)
            if clase and indice.isdigit():
                puertos[int(indice)] = {"nombre": str(v).strip(), "clase": clase}
    except SinRespuesta as e:
        print(f"\nLa OLT {e} al leer los nombres de sus interfaces.")

    try:
        tx = snmp.recorrer(f"{OPTICA}.4", 200)
        print(f"\n== Óptica de los puertos PON (hwGponOltOpticsDdmInfoTable): {len(tx)} puertos con fila")
        indices = [int(i) for i, _ in tx if i.isdigit()]
        if not indices:
            print("La OLT no devolvió esa tabla: puede no tenerla este modelo o esta versión.")
        nombres = snmp.get([f"{NOMBRE_IF}.{i}" for i in indices])
        optica = snmp.get([f"{OPTICA}.{c}.{i}" for i in indices for c in COLUMNAS])
        estados = snmp.get([f"{ESTADO_IF}.{i}" for i in indices])
        print("puerto            ifIndex      estado  TX dBm   °C   mA     V    RX dBm")
        for i in indices:
            col = {nombre: optica.get(f"{OPTICA}.{c}.{i}") for c, nombre in COLUMNAS.items()}
            nombre = str(nombres.get(f"{NOMBRE_IF}.{i}") or puerto_gpon(i) or "?")
            estado = {1: "arriba", 2: "abajo"}.get(estados.get(f"{ESTADO_IF}.{i}"), "?")
            print(f"{nombre[:17]:17} {i:<12} {estado:7} {numero(col['tx'], 100, 2):>6} {numero(col['temperatura'], 1, 0):>5} "
                  f"{numero(col['corriente'], 1, 0):>4} {numero(col['tension'], 100, 2):>6} {numero(col['rx'], 100, 2):>8}")
            if i not in puertos:  # un puerto PON que la OLT nombra de otra manera
                puertos[i] = {"nombre": nombre, "clase": "pon"}
        sin_tx = sum(1 for i in indices if optica.get(f"{OPTICA}.4.{i}") in (None, SIN_DATO))
        if indices:
            print(f"({len(indices) - sin_tx} con potencia de salida leída; {sin_tx} sin lectura: puerto sin SFP o apagado.)")
    except SinRespuesta as e:
        print(f"\nLa OLT {e} al leer la óptica de los puertos.")

    # --- el tráfico de cada puerto, medido con cada contador que puede tener
    try:
        indices = sorted(puertos, key=lambda i: (puertos[i]["clase"] != "eth", i))
        estados = snmp.get([f"{ESTADO_IF}.{i}" for i in indices])
        velocidades = snmp.get([f"{VELOCIDAD_IF}.{i}" for i in indices])
        sin_respuesta = {}  # el contador que la OLT no contestó, con lo que dijo

        def leer_contadores():
            """Una lectura de cada contador (cada uno por separado: si uno no responde, los otros se miden igual)."""
            valores = {}
            for rotulo, entra, sale, solo_pon in CONTADORES:
                if rotulo in sin_respuesta:
                    continue
                try:
                    valores.update(snmp.get([f"{base}.{i}" for i in indices for base in (entra, sale)
                                             if not solo_pon or puertos[i]["clase"] == "pon"]))
                except SinRespuesta as e:
                    sin_respuesta[rotulo] = str(e)
            return valores

        t0 = time.monotonic()
        antes = leer_contadores()
        medio = (t0 + time.monotonic()) / 2
        time.sleep(max(2.0, args.lapso))
        t1 = time.monotonic()
        despues = leer_contadores()
        lapso = (t1 + time.monotonic()) / 2 - medio
        print(f"\n== Tráfico de cada puerto en {lapso:.0f} s, en Mb/s, según cada contador (entra / sale; «quieto»: no cambió; «—»: no está)")
        for rotulo, motivo in sin_respuesta.items():
            print(f"(al pedir los contadores «{rotulo}», la OLT {motivo})")
        print(f"{'puerto':17} {'estado':8} {'Mb':>6}   {'64 bits (IF-MIB)':>22}   {'32 bits (IF-MIB)':>22}   {'Huawei (puertos PON)':>22}")
        movidos = {rotulo: {"pon": 0, "eth": 0} for rotulo, *_ in CONTADORES}
        for i in indices:
            clase = puertos[i]["clase"]
            celdas = []
            for rotulo, entra, sale, solo_pon in CONTADORES:
                if solo_pon and clase != "pon":
                    celdas.append("")
                    continue
                par = [ritmo(antes.get(f"{b}.{i}"), despues.get(f"{b}.{i}"), lapso) for b in (entra, sale)]
                if any(x not in ("—", "quieto", "volvió a 0") for x in par):
                    movidos[rotulo][clase] += 1
                celdas.append(" / ".join(par))
            estado = {1: "arriba", 2: "abajo", 6: "sin SFP"}.get(estados.get(f"{ESTADO_IF}.{i}"), "?")
            velocidad = velocidades.get(f"{VELOCIDAD_IF}.{i}")
            print(f"{puertos[i]['nombre'][:17]:17} {estado:8} {velocidad if isinstance(velocidad, int) else '—':>6}   "
                  f"{celdas[0]:>22}   {celdas[1]:>22}   {celdas[2]:>22}")
        cuantos = {clase: sum(1 for p in puertos.values() if p["clase"] == clase) for clase in ("pon", "eth")}
        print(f"({cuantos['pon']} puertos PON y {cuantos['eth']} de subida o de control. Se movieron: "
              + "; ".join(f"{rotulo}: {m['pon']} PON y {m['eth']} de los otros" for rotulo, m in movidos.items())
              + ". «entra» es lo que sube de los clientes y «sale» lo que baja hacia ellos.)")
    except SinRespuesta as e:
        print(f"\nLa OLT {e} al medir el tráfico.")
    print("\n== Las tablas que traza lee de una OLT cargada en el visor (filas, tiempo, primer índice y primeros valores)")
    for rotulo, columna, clase, limite in TABLAS:
        t0 = time.monotonic()
        try:
            filas = snmp.recorrer(columna, limite)
        except SinRespuesta as e:
            print(f"{rotulo}: la OLT {e}")
            continue
        muestra = []
        for _, v in filas[:3]:
            if clase == "privado":
                v = f"({len(str(v))} caracteres)"
            elif clase == "serie":  # el fabricante sí, el resto no
                v = f"{str(v)[:8]}… ({len(str(v))} caracteres)"
            muestra.append(str(v)[:40])
        tope = " (se pidieron solo esas)" if len(filas) >= limite else ""
        print(f"{rotulo}: {len(filas)} filas{tope} en {time.monotonic() - t0:.1f} s · primer índice {filas[0][0] if filas else '—'} · {muestra}")
    print(f"\nListo: {snmp.pedidos} pedidos SNMP en {time.monotonic() - inicio:.1f} s, todos de lectura. Nada se cambió en la OLT.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
