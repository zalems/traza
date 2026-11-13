#!/usr/bin/env python3
"""Lee por SNMP, directo de la OLT, lo que el panel no entrega de cada puerto PON:
la potencia de salida del SFP, su temperatura, corriente y tensión, y el tráfico.

Sirve para comprobar, antes de sumarlo a traza, que desde este servidor se llega a
la OLT por SNMP y que la OLT responde esas tablas. Solo lee (GET y GETBULK de SNMP
v2c): no cambia nada en la OLT. La community se escribe sin que se vea y no se
guarda en ningún lado. No necesita nada instalado (habla SNMP por su cuenta).

Uso, en el servidor de traza:
    python3 herramientas/muestras-snmp.py --olt 1               # toma la dirección de la OLT 1 del panel
    python3 herramientas/muestras-snmp.py --host 192.0.2.10     # o se indica la dirección (y --puerto si no es 161)
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
# HUAWEI-XPON-MIB hwGponOltOpticsDdmInfoTable: la óptica de cada puerto PON, por ifIndex.
OPTICA = "1.3.6.1.4.1.2011.6.128.1.1.2.23.1"
COLUMNAS = {1: "temperatura", 2: "tension", 3: "corriente", 4: "tx", 5: "rx"}
SIN_DATO = 2147483647  # lo que Huawei devuelve cuando no hay lectura
GPON = 0xFA000000  # los ifIndex de los puertos GPON de Huawei empiezan acá (tipo 125)


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


def numero(v, divisor=1, decimales=1):
    if not isinstance(v, int) or v == SIN_DATO:
        return "—"
    return f"{v / divisor:.{decimales}f}".replace(".", ",")


def main():
    ap = argparse.ArgumentParser(description="Lee por SNMP la óptica y el tráfico de los puertos PON de una OLT Huawei (solo lectura).")
    ap.add_argument("--olt", help="número de la OLT en el panel: se toma de ahí su dirección")
    ap.add_argument("--panel", default="http://10.10.0.230:8080", help="dirección del panel de la OLT")
    ap.add_argument("--host", help="dirección de la OLT (si no se usa --olt)")
    ap.add_argument("--puerto", type=int, default=161, help="puerto SNMP de la OLT (por defecto 161)")
    ap.add_argument("--espera", type=float, default=3.0, help="segundos que se espera cada respuesta")
    args = ap.parse_args()
    if not args.host and not args.olt:
        ap.error("indicá --olt N (la toma del panel) o --host DIRECCIÓN")
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
    print(f"######## SNMP a la OLT{f' {args.olt}' if args.olt else ''}{f' ({modelo})' if modelo else ''}, puerto {args.puerto}")
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
              "(en Huawei: snmp-agent acl); el puerto no es el 161 (--puerto N); o un firewall en el medio.")
        return 1
    for rotulo, oid in SISTEMA.items():
        v = sistema.get(oid)
        if rotulo == "encendida hace" and isinstance(v, int):
            v = f"{v // 8640000} días, {v % 8640000 // 360000} h"
        print(f"{rotulo}: {str(v)[:160]}")
    print(f"(responde desde {snmp.desde()} en {time.monotonic() - inicio:.2f} s)")

    try:
        tx = snmp.recorrer(f"{OPTICA}.4", 200)
        print(f"\n== Óptica de los puertos PON (hwGponOltOpticsDdmInfoTable): {len(tx)} puertos con fila")
        indices = [int(i) for i, _ in tx if i.isdigit()]
        if not indices:
            print("La OLT no devolvió esa tabla: puede no tenerla este modelo o esta versión.")
        nombres = snmp.get([f"{NOMBRE_IF}.{i}" for i in indices])
        optica = snmp.get([f"{OPTICA}.{c}.{i}" for i in indices for c in COLUMNAS])
        estados = snmp.get([f"{ESTADO_IF}.{i}" for i in indices])
        antes = snmp.get([f"{b}.{i}" for i in indices for b in (ENTRA_IF, SALE_IF)])
        t0 = time.monotonic()
        time.sleep(5)
        despues = snmp.get([f"{b}.{i}" for i in indices for b in (ENTRA_IF, SALE_IF)])
        lapso = time.monotonic() - t0
        print("puerto            ifIndex      estado  TX dBm   °C   mA     V    RX dBm   entra Mbps  sale Mbps")
        for i in indices:
            col = {nombre: optica.get(f"{OPTICA}.{c}.{i}") for c, nombre in COLUMNAS.items()}
            mbps = []
            for base in (ENTRA_IF, SALE_IF):
                a, b = antes.get(f"{base}.{i}"), despues.get(f"{base}.{i}")
                mbps.append(numero(round((b - a) * 8 / lapso / 1e4), 100, 2) if isinstance(a, int) and isinstance(b, int) and b >= a else "—")
            nombre = str(nombres.get(f"{NOMBRE_IF}.{i}") or puerto_gpon(i) or "?")
            estado = {1: "arriba", 2: "abajo"}.get(estados.get(f"{ESTADO_IF}.{i}"), "?")
            print(f"{nombre[:17]:17} {i:<12} {estado:7} {numero(col['tx'], 100, 2):>6} {numero(col['temperatura'], 1, 0):>5} "
                  f"{numero(col['corriente'], 1, 0):>4} {numero(col['tension'], 100, 2):>6} {numero(col['rx'], 100, 2):>8} {mbps[0]:>11} {mbps[1]:>10}")
        sin_tx = sum(1 for i in indices if optica.get(f"{OPTICA}.4.{i}") in (None, SIN_DATO))
        if indices:
            print(f"({len(indices) - sin_tx} con potencia de salida leída; {sin_tx} sin lectura: puerto sin SFP o apagado. "
                  f"«entra» y «sale» son de la OLT: lo que sube de los clientes y lo que baja hacia ellos.)")
    except SinRespuesta as e:
        print(f"\nLa OLT {e} al leer la óptica de los puertos.")
    print(f"\nListo: {snmp.pedidos} pedidos SNMP en {time.monotonic() - inicio:.1f} s, todos de lectura. Nada se cambió en la OLT.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
