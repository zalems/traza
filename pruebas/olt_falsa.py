"""Una OLT Huawei de mentira para las pruebas: responde SNMP v2c (GET, GETNEXT y
GETBULK) con las tablas que traza lee de una MA5800/EA5800 y atiende Telnet como
ella. No sale de la máquina (127.0.0.1) y no necesita nada instalado.

    olt = OltFalsa(api)          # api: el módulo ftth-api cargado (se usan sus funciones BER)
    olt.puerto, olt.telnet       # dónde atiende (UDP y TCP)
    olt.caer("HWTC00000103")     # una ONT se queda sin luz
    olt.cerrar()
"""

import bisect
import socket
import threading
import time
from datetime import datetime, timedelta, timezone

GPON = 0xFA000000  # ifIndex de 'GPON 0/slot/puerto': GPON + slot * 8192 + puerto * 256
ETH = 234881024  # ifIndex de 'ethernet0/slot/puerto': ETH + slot * 8192 + puerto * 64
XPON = "1.3.6.1.4.1.2011.6.128.1.1.2"
SLOT = "1.3.6.1.4.1.2011.6.3.3.2.1"
SIN_DATO = 2147483647


def chasis_x2():
    """Una EA5800-X2 como la figura de Huawei: energía en 0, dos placas GPON y dos de control."""
    return {0: "H901PISB", 1: "H901GPHF", 2: "H902GPSF", 3: "H901MPSC", 4: "H901MPSC"}


def chasis_x17():
    return {0: "H901CIUA", 9: "H903MPLA", 10: "H903MPLA", 18: "H901GPHF", 19: "H901GPHF", 20: "H901PILA", 21: "H901PILA"}


class OltFalsa:
    def __init__(self, api, community="lectura-de-prueba", placas=None, onts_por_puerto=3, puertos_con_onts=4,
                 usuario="traza", clave="Clave-de-la-olt", nombre="OLT-DE-PRUEBA", utc=-180, host="127.0.0.1",
                 puerto_snmp=0, puerto_telnet=0):
        self.api = api
        self.community = community
        self.usuario, self.clave, self.nombre, self.utc = usuario, clave, nombre, utc
        self.placas = placas or chasis_x2()
        self.arranque = time.time()
        self.candado = threading.Lock()
        self.pedidos = 0  # cuántos pedidos SNMP atendió
        self.sesiones = 0  # cuántas veces entraron por Telnet
        self.lenta = 0.0  # segundos que demora cada respuesta
        self.muda = False  # no contesta (como con la comunidad equivocada)
        self.onts = {}  # índice 'ifIndex.ont' -> {sn, descripcion, en_linea, causa, cayo, distancia, rx}
        self.pon, self.eth = [], []
        n = 100
        for slot, nombre_placa in sorted(self.placas.items()):
            tipo = nombre_placa[4:6]
            if tipo in ("GP", "XG"):
                for puerto in range(16):
                    self.pon.append((GPON + slot * 8192 + puerto * 256, slot, puerto))
            elif tipo == "MP":
                for puerto in range(4):
                    self.eth.append((ETH + slot * 8192 + puerto * 64, slot, puerto))
        for ifindex, slot, puerto in self.pon[:puertos_con_onts]:
            for ont in range(onts_por_puerto):
                n += 1
                self.onts[f"{ifindex}.{ont}"] = {
                    "sn": b"HWTC" + n.to_bytes(4, "big"), "descripcion": f"#{n} Cliente {n}", "en_linea": True,
                    "causa": -1, "cayo": None, "distancia": 800 + 37 * ont, "rx": -1850 - 110 * ont - 40 * puerto}
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((host, puerto_snmp))
        self.puerto = self.sock.getsockname()[1]
        self.escucha = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.escucha.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.escucha.bind((host, puerto_telnet))
        self.escucha.listen(8)
        self.telnet = self.escucha.getsockname()[1]
        self.viva = True
        threading.Thread(target=self._snmp, daemon=True).start()
        threading.Thread(target=self._telnet, daemon=True).start()

    # ------------------------------------------------------------ lo que cambia

    def sn_texto(self, indice):
        return self.onts[indice]["sn"][:4].decode() + self.onts[indice]["sn"][4:].hex().upper()

    def indice_de(self, sn):
        return next(i for i in self.onts if self.sn_texto(i) == sn)

    def caer(self, sn, causa=2, cuando=None):
        """Una ONT deja de estar en línea (causa 2: LOSi, sin luz; 13: dying gasp, sin energía)."""
        with self.candado:
            o = self.onts[self.indice_de(sn)]
            o.update({"en_linea": False, "causa": causa, "cayo": cuando or time.time()})

    def volver(self, sn):
        with self.candado:
            self.onts[self.indice_de(sn)]["en_linea"] = True

    def agregar(self, puerto_pon, sn_numero, descripcion):
        """Una ONT nueva en el puerto PON número `puerto_pon` (de la lista de puertos)."""
        ifindex = self.pon[puerto_pon][0]
        with self.candado:
            ont = sum(1 for i in self.onts if i.startswith(f"{ifindex}."))
            self.onts[f"{ifindex}.{ont}"] = {"sn": b"HWTC" + sn_numero.to_bytes(4, "big"), "descripcion": descripcion,
                                             "en_linea": True, "causa": -1, "cayo": None, "distancia": 500, "rx": -2100}

    def cerrar(self):
        self.viva = False
        for s in (self.sock, self.escucha):
            try:
                s.close()
            except OSError:
                pass

    # --------------------------------------------------------------- la MIB

    def _fecha(self, t):
        if t is None:
            return bytes(8)
        d = datetime.fromtimestamp(t, timezone.utc) + timedelta(minutes=self.utc)
        return d.year.to_bytes(2, "big") + bytes([d.month, d.day, d.hour, d.minute, d.second, 0])

    def mib(self):
        """[(oid como tupla, tipo BER, contenido)] en orden, como está ahora."""
        a = self.api
        entero = lambda n: (0x02, a.ber_entero(n)[2:])  # noqa: E731 (sin la etiqueta ni el largo)
        texto = lambda t: (0x04, t.encode() if isinstance(t, str) else t)  # noqa: E731
        contador = lambda n: (0x46, n.to_bytes(max(1, (n.bit_length() + 8) // 8), "big"))  # noqa: E731
        filas = {}

        def poner(oid, valor):
            filas[tuple(int(x) for x in oid.split("."))] = valor

        andando = time.time() - self.arranque
        poner("1.3.6.1.2.1.1.1.0", texto("Huawei Integrated Access Software"))
        poner("1.3.6.1.2.1.1.3.0", (0x43, int(andando * 100 + 8640000).to_bytes(4, "big")))
        poner("1.3.6.1.2.1.1.5.0", texto(self.nombre))
        with self.candado:
            onts = {i: dict(o) for i, o in self.onts.items()}
        for ifindex, slot, puerto in self.pon:
            suyas = [o for i, o in onts.items() if i.startswith(f"{ifindex}.")]
            arriba = bool(suyas)
            poner(f"1.3.6.1.2.1.2.2.1.8.{ifindex}", entero(1 if arriba else 2))
            poner(f"1.3.6.1.2.1.31.1.1.1.1.{ifindex}", texto(f"GPON 0/{slot}/{puerto}"))
            # Por un puerto PON sale la bajada (40 Mb/s por ONT en línea) y entra la subida (4 Mb/s).
            en_linea = sum(1 for o in suyas if o["en_linea"])
            poner(f"1.3.6.1.2.1.31.1.1.1.6.{ifindex}", contador(int(andando * en_linea * 500000) + 10 ** 9))
            poner(f"1.3.6.1.2.1.31.1.1.1.10.{ifindex}", contador(int(andando * en_linea * 5000000) + 10 ** 10))
            poner(f"1.3.6.1.2.1.31.1.1.1.15.{ifindex}", (0x42, (2500).to_bytes(2, "big")))
            # El módulo de cada puerto emite aunque no tenga ONT (los de la segunda placa, sin módulo).
            con_modulo = slot == self.pon[0][1]
            for col, valor in ((1, 41 + puerto % 5), (2, 331), (3, 12 + puerto % 4), (4, 320 + 7 * puerto), (5, SIN_DATO)):
                if not con_modulo:
                    valor = SIN_DATO
                poner(f"{XPON}.23.1.{col}.{ifindex}", entero(valor))
        total = sum(1 for o in onts.values() if o["en_linea"])
        for n, (ifindex, slot, puerto) in enumerate(self.eth):
            arriba = n == 0  # una sola subida conectada
            poner(f"1.3.6.1.2.1.2.2.1.8.{ifindex}", entero(1 if arriba else 6))
            poner(f"1.3.6.1.2.1.31.1.1.1.1.{ifindex}", texto(f"ethernet0/{slot}/{puerto}"))
            poner(f"1.3.6.1.2.1.31.1.1.1.6.{ifindex}", contador(int(andando * total * 5000000) + 10 ** 11 if arriba else 0))
            poner(f"1.3.6.1.2.1.31.1.1.1.10.{ifindex}", contador(int(andando * total * 500000) + 10 ** 9 if arriba else 0))
            poner(f"1.3.6.1.2.1.31.1.1.1.15.{ifindex}", (0x42, (10000).to_bytes(2, "big")))
        # Otras interfaces que no son puertos de una placa (no se tienen que contar).
        poner("1.3.6.1.2.1.31.1.1.1.1.1", texto("meth0"))
        poner("1.3.6.1.2.1.31.1.1.1.1.2", texto("vlanif100"))
        poner("1.3.6.1.2.1.2.2.1.8.1", entero(1))
        for slot, nombre in self.placas.items():
            poner(f"{SLOT}.3.0.{slot}", texto(f"{nombre}_0_Board"))
            poner(f"{SLOT}.8.0.{slot}", entero(2))
            poner(f"{SLOT}.21.0.{slot}", texto(nombre))
        for indice, o in onts.items():
            poner(f"{XPON}.43.1.3.{indice}", texto(o["sn"]))
            poner(f"{XPON}.43.1.9.{indice}", texto(o["descripcion"]))
            poner(f"{XPON}.46.1.15.{indice}", entero(1 if o["en_linea"] else 2))
            poner(f"{XPON}.46.1.20.{indice}", entero(o["distancia"] if o["en_linea"] else -1))
            poner(f"{XPON}.46.1.23.{indice}", texto(self._fecha(o["cayo"])))
            poner(f"{XPON}.46.1.24.{indice}", entero(o["causa"]))
            poner(f"{XPON}.51.1.4.{indice}", entero(o["rx"] if o["en_linea"] else SIN_DATO))
        return sorted(filas.items())

    # ------------------------------------------------------------------ SNMP

    def _snmp(self):
        a = self.api
        while self.viva:
            try:
                data, de = self.sock.recvfrom(65535)
            except OSError:
                return
            try:
                _, cuerpo, _ = a.ber_leer(data, 0)
                _, _, pos = a.ber_leer(cuerpo, 0)
                _, comunidad, pos = a.ber_leer(cuerpo, pos)
                tipo, pdu, _ = a.ber_leer(cuerpo, pos)
                _, rid, pos = a.ber_leer(pdu, 0)
                _, no_rep, pos = a.ber_leer(pdu, pos)
                _, max_rep, pos = a.ber_leer(pdu, pos)
                _, lista, _ = a.ber_leer(pdu, pos)
                pedidos, pos = [], 0
                while pos < len(lista):
                    _, enlace, pos = a.ber_leer(lista, pos)
                    _, oid, _ = a.ber_leer(enlace, 0)
                    pedidos.append(tuple(int(x) for x in a.ber_oid_texto(oid).split(".")))
            except (ValueError, IndexError):
                continue
            self.pedidos += 1
            if self.muda or comunidad != self.community.encode():
                continue  # como una OLT de verdad: con otra comunidad no contesta nada
            if self.lenta:
                time.sleep(self.lenta)
            mib = self.mib()
            claves = [k for k, _ in mib]
            enlaces = []

            def siguiente(oid):
                i = bisect.bisect_right(claves, oid)
                return mib[i] if i < len(mib) else None

            def enlace(oid, valor):
                return a.ber_tlv(0x30, a.ber_oid(".".join(map(str, oid))) + a.ber_tlv(valor[0], valor[1]))

            if tipo == 0xA0:  # GET
                tabla = dict(mib)
                for oid in pedidos:
                    enlaces.append(enlace(oid, tabla.get(oid, (0x81, b""))))
            elif tipo in (0xA1, 0xA5):  # GETNEXT, GETBULK
                veces = 1 if tipo == 0xA1 else max(1, min(int.from_bytes(max_rep, "big"), 60))
                for oid in pedidos:
                    actual = oid
                    for _ in range(veces):
                        fila = siguiente(actual)
                        if fila is None:
                            enlaces.append(enlace(actual, (0x82, b"")))
                            break
                        enlaces.append(enlace(fila[0], fila[1]))
                        actual = fila[0]
            else:
                continue
            respuesta = a.ber_tlv(0xA2, a.ber_tlv(0x02, rid) + a.ber_entero(0) + a.ber_entero(0) + a.ber_tlv(0x30, b"".join(enlaces)))
            try:
                self.sock.sendto(a.ber_tlv(0x30, a.ber_entero(1) + a.ber_tlv(0x04, comunidad) + respuesta), de)
            except OSError:
                return

    # ---------------------------------------------------------------- Telnet

    def _telnet(self):
        while self.viva:
            try:
                conn, _ = self.escucha.accept()
            except OSError:
                return
            threading.Thread(target=self._sesion, args=(conn,), daemon=True).start()

    def _sesion(self, conn):
        conn.settimeout(10)

        def linea():
            buf = b""
            while not buf.endswith(b"\n"):
                parte = conn.recv(1)
                if not parte:
                    raise OSError("cerrada")
                if parte[0] == 255:  # una orden de Telnet (IAC x y): se ignora
                    conn.recv(2)
                    continue
                buf += parte
            return buf.decode("latin-1").strip()

        try:
            conn.sendall(b"\xff\xfb\x01\xff\xfb\x03\r\nWarning: Telnet is not a secure protocol.\r\n")
            for _ in range(3):
                conn.sendall(b"\r\n>>User name:")
                usuario = linea()
                conn.sendall(b">>User password:")
                clave = linea()
                if usuario == self.usuario and clave == self.clave:
                    break
                conn.sendall(b"\r\nUsername or password invalid.\r\n")
            else:
                return
            self.sesiones += 1
            conn.sendall(b"\r\n  Huawei Integrated Access Software (MA5800).\r\n  Copyright(C) Huawei Technologies Co., Ltd.\r\n\r\n"
                         + self.nombre.encode() + b">")
            while True:
                orden = linea()
                if orden == "quit":
                    conn.sendall(b"\r\n  Check whether system data has been changed. Please save data before logout.\r\n"
                                 b"Are you sure to log out? (y/n)[n]:")
                    if linea().lower() == "y":
                        return
                conn.sendall(b"\r\n" + self.nombre.encode() + b">")
        except OSError:
            pass
        finally:
            conn.close()
