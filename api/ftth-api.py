#!/usr/bin/env python3
"""API de la red FTTH: redes, elementos, cables y cartas de empalme.

Un solo archivo, sin dependencias fuera de la biblioteca estándar. Guarda todo
en SQLite y atiende en 127.0.0.1 detrás de nginx, que solo deja pasar pedidos
con sesión y agrega tres cabeceras: X-Usuario y X-Redes (las obtiene de
ftth-auth.py: quién es y qué redes puede ver, "*" todas, "1,3" esas, "-"
ninguna; sin la cabecera, todas) y X-Ftth-Secreto, una clave que comparten
nginx y este servicio para que ningún otro programa de la máquina pueda
hablarle a la API haciéndose pasar por nginx. Todo lo que es de una red que el
usuario no puede ver responde 403.

  GET    /api/salud                    el servicio está vivo (sin sesión): esquema de la base y, con
                                       la clave de nginx, el código del programa que atiende
  GET    /api/yo                       quién está conectado, si administra y qué redes ve
  GET    /api/redes                    redes (una por cliente o despliegue) que el usuario puede ver
  POST   /api/redes                    {nombre} (solo quien administra)
  PUT    /api/redes/ID                 {nombre} (solo quien administra)
  GET    /api/red?red=ID               toda la red (GeoJSON, equipos y uniones) y la versión actual;
                                       red=todas: todas juntas, cada objeto con su red (solo administra)
  GET    /api/cambios?red=ID&desde=V   lo que cambió después de la versión V (incluye bajas); red=todas idem
  POST   /api/elementos                {red, tipo, nombre, estado, lon, lat, datos, notas}
  PUT    /api/elementos/ID             los mismos campos y carta, todos opcionales; mover = lon y lat.
                                       carta es la disposición de la carta de empalme y llega como
                                       cambio parcial: {lados, orden, pos} (ver carta_field)
  DELETE /api/elementos/ID?version=V   baja lógica; los cables pegados quedan sueltos en ese punto
  POST   /api/cables                   {red, nombre, tipo, fibras, por_tubo, colores, estado, tendido, coords, nodos, datos, notas}
  PUT    /api/cables/ID
  DELETE /api/cables/ID?version=V      también quita las uniones de sus fibras
  POST   /api/equipos                  {elemento, tipo, nombre, entradas, salidas, datos, notas}: splitter u OLT
  PUT    /api/equipos/ID
  DELETE /api/equipos/ID?version=V     también quita las uniones de sus puertos
  POST   /api/fusiones                 {elemento, pares: [{a, b}], tipo}: une fibras y puertos en un elemento
  PUT    /api/fusiones/ID              {a o b, version}: pasa una punta de la unión a otra fibra o puerto
  DELETE /api/fusiones/ID?version=V
  POST   /api/fusiones/borrar          {ids}: quita varias uniones (deshacer)
  GET    /api/historial?red=ID&limite=N   últimos cambios (quién, qué, cuándo)

Wispro y el panel de la OLT (se configuran en el servidor, ver "integraciones"):
  GET    /api/integracion?red=ID       si la red está conectada con Wispro y con el panel de la OLT
  GET    /api/integracion/nap?elemento=ID       la NAP en Wispro, sus contratos, el cliente de traza de
                                       cada uno y la potencia de su ONT (refrescar=1 vuelve a leer;
                                       candidatas=1 suma las NAPs de Wispro con que se puede vincular)
  GET    /api/integracion/cliente?elemento=ID   el contrato de un cliente y su ONT
  POST   /api/integracion/nap/medir    {elemento}: potencia en vivo de las ONTs de la NAP, por Wispro
  POST   /api/integracion/cliente/medir  {elemento}
  POST   /api/integracion/nap/importar {elemento, contratos}: agrega al mapa los clientes que faltan
  POST   /api/integracion/vincular     {cliente, contrato}: confirma que un cliente es el de ese contrato
  POST   /api/integracion/desvincular  {cliente, contrato, deshacer?}: ese cliente no es el de ese contrato
  GET    /api/integracion/importacion?red=N[&olts=A,B][&leer=0]  qué cajas y clientes de Wispro faltan en el mapa
         (sin cambiar nada), de qué OLTs de Wispro; leer=0: con la última lectura de Wispro
  POST   /api/integracion/importacion  {red, cajas, clientes, igual?, olts?}: los agrega de una vez (una versión)
  POST   /api/integracion/importacion/deshacer {red, version}: quita lo que agregó esa importación
  POST   /api/integracion/importacion/quitar {red, olts}: quita lo que se trajo de esas OLTs de Wispro

Extremos de una unión, siempre dentro de un elemento:
  cCABLE:LADO:FIBRA   fibra de un cable; LADO a = el tramo hacia el comienzo del
                      cable, b = el tramo hacia el final (un cable que pasa por el
                      elemento tiene los dos; uno que empieza o termina, uno solo)
  qEQUIPO:e:N         entrada N de un splitter
  qEQUIPO:s:N         salida N de un splitter o puerto PON N de una OLT

PUT y DELETE aceptan la versión que el usuario tenía a la vista: si mientras
tanto alguien cambió ese objeto, la respuesta es 409 con el estado actual.

Uso:
  ftth-api.py serve [--db RUTA] [--port 8901] [--secreto ARCHIVO] [--integraciones ARCHIVO]
  ftth-api.py integraciones ver | wispro RED | panel RED URL [--olt N] | quitar RED [wispro|panel] | probar RED
"""

import argparse
import errno
import getpass
import hashlib
import hmac
import http.client
import json
import logging
import math
import os
import re
import socket
import sqlite3
import ssl
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, wait
from concurrent.futures import TimeoutError as FuturesTimeout
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

MAX_BODY = 256 * 1024
MAX_NOMBRE = 80
TODAS = "todas"  # red=todas: todas las redes juntas, solo para leer y solo para quien administra
MAX_NOTAS = 2000
MAX_DATOS = 8 * 1024
MAX_VERTICES = 2000
MAX_FIBRAS = 864
MAX_POR_TUBO = 48
MAX_PARES = 864
MAX_LADOS = 400
MAX_BLOQUES = 800  # cables y equipos que se pueden acomodar en una carta
MAX_POS = 100000  # coordenadas del modo libre, en píxeles
MAX_CARTA = 96 * 1024

TIPOS_ELEMENTO = ("nodo", "poste", "caja", "nap", "botella", "cliente", "reserva")
TIPOS_CABLE = ("troncal", "distribucion", "bajada")
ESTADOS = ("proyectado", "instalado", "activo", "baja")
TENDIDOS = ("aereo", "subterraneo", "fachada")
# Código de colores de fibras y tubos: TIA-598 (azul, naranja, verde…) o ABNT,
# el de los cables fabricados en Brasil (verde, amarillo, blanco…).
COLORES = ("tia598", "abnt")

# Dónde se arma una carta de empalme (uniones de fibras y equipos adentro).
TIPOS_CON_CARTA = ("nodo", "caja", "nap", "botella")
TIPOS_EQUIPO = ("splitter", "olt")
MODOS_SPLITTER = ("plc", "fbt")
SALIDAS_PLC = (2, 4, 8, 16, 32, 64, 128)
MAX_PUERTOS_OLT = 256
TIPOS_UNION = ("fusion", "conector")

EXTREMO_CABLE = re.compile(r"c([1-9][0-9]{0,15}):([ab]):([1-9][0-9]{0,3})")
EXTREMO_EQUIPO = re.compile(r"q([1-9][0-9]{0,15}):([es]):([1-9][0-9]{0,3})")
LADO_CARTA = re.compile(r"c([1-9][0-9]{0,15}):([ab])")
# Un bloque de la carta: el lado de un cable (c12:a) o un equipo (q3).
BLOQUE_CARTA = re.compile(r"c[1-9][0-9]{0,15}:[ab]|q[1-9][0-9]{0,15}")
RELACION_FBT = re.compile(r"([1-9][0-9]?)/([1-9][0-9]?)")

# Versión del esquema de la base (PRAGMA user_version). Cada cambio de
# estructura suma un paso en MIGRACIONES.
ESQUEMA = 2


def codigo_propio() -> str:
    """Resumen de este archivo tal como se cargó: el instalador lo compara con el
    instalado para saber que la API que atiende es la nueva (y no una vieja que
    no se reinició)."""
    try:
        with open(os.path.abspath(__file__), "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()[:12]
    except OSError:
        return ""


CODIGO = codigo_propio()

log = logging.getLogger("ftth-api")


class ApiError(Exception):
    def __init__(self, status: int, message: str, extra: dict = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


# ------------------------------------------------------------------------- base

MIGRACIONES = {
    1: """
CREATE TABLE IF NOT EXISTS meta (
    clave  TEXT PRIMARY KEY,
    valor  INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta (clave, valor) VALUES ('version', 0);

CREATE TABLE IF NOT EXISTS redes (
    id          INTEGER PRIMARY KEY,
    nombre      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    creado      TEXT NOT NULL,
    creado_por  TEXT
);

CREATE TABLE IF NOT EXISTS elementos (
    id              INTEGER PRIMARY KEY,
    red_id          INTEGER NOT NULL REFERENCES redes(id),
    tipo            TEXT NOT NULL,
    nombre          TEXT NOT NULL DEFAULT '',
    estado          TEXT NOT NULL DEFAULT 'instalado',
    lon             REAL NOT NULL,
    lat             REAL NOT NULL,
    datos           TEXT NOT NULL DEFAULT '{}',
    notas           TEXT NOT NULL DEFAULT '',
    creado          TEXT NOT NULL,
    creado_por      TEXT,
    modificado      TEXT NOT NULL,
    modificado_por  TEXT,
    version         INTEGER NOT NULL,
    borrado         TEXT
);
CREATE INDEX IF NOT EXISTS elementos_red_version ON elementos(red_id, version);

CREATE TABLE IF NOT EXISTS cables (
    id              INTEGER PRIMARY KEY,
    red_id          INTEGER NOT NULL REFERENCES redes(id),
    tipo            TEXT NOT NULL,
    nombre          TEXT NOT NULL DEFAULT '',
    fibras          INTEGER NOT NULL DEFAULT 12,
    estado          TEXT NOT NULL DEFAULT 'instalado',
    tendido         TEXT NOT NULL DEFAULT 'aereo',
    coords          TEXT NOT NULL,
    nodos           TEXT NOT NULL,
    largo_m         REAL NOT NULL DEFAULT 0,
    datos           TEXT NOT NULL DEFAULT '{}',
    notas           TEXT NOT NULL DEFAULT '',
    creado          TEXT NOT NULL,
    creado_por      TEXT,
    modificado      TEXT NOT NULL,
    modificado_por  TEXT,
    version         INTEGER NOT NULL,
    borrado         TEXT
);
CREATE INDEX IF NOT EXISTS cables_red_version ON cables(red_id, version);

-- Qué elementos sostienen a qué cables: para que un cable siga a su poste.
CREATE TABLE IF NOT EXISTS anclajes (
    cable_id     INTEGER NOT NULL REFERENCES cables(id),
    elemento_id  INTEGER NOT NULL REFERENCES elementos(id),
    PRIMARY KEY (cable_id, elemento_id)
);
CREATE INDEX IF NOT EXISTS anclajes_elemento ON anclajes(elemento_id);

CREATE TABLE IF NOT EXISTS historial (
    id           INTEGER PRIMARY KEY,
    red_id       INTEGER NOT NULL,
    fecha        TEXT NOT NULL,
    usuario      TEXT,
    accion       TEXT NOT NULL,
    tabla        TEXT NOT NULL,
    registro_id  INTEGER NOT NULL,
    detalle      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS historial_red ON historial(red_id, id);
""",
    # 0.4.0: estructura de fibras de los cables y cartas de empalme.
    2: """
-- Fibras por tubo (0 = automático: hasta 12 en un tubo, si no tubos de 12) y
-- código de colores de fibras y tubos.
ALTER TABLE cables ADD COLUMN por_tubo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cables ADD COLUMN colores TEXT NOT NULL DEFAULT 'tia598';

-- Cómo se dibuja la carta de empalme (de qué lado va cada cable).
ALTER TABLE elementos ADD COLUMN carta TEXT NOT NULL DEFAULT '{}';

-- Equipos dentro de un elemento: splitters y OLT.
CREATE TABLE IF NOT EXISTS equipos (
    id              INTEGER PRIMARY KEY,
    red_id          INTEGER NOT NULL REFERENCES redes(id),
    elemento_id     INTEGER NOT NULL REFERENCES elementos(id),
    tipo            TEXT NOT NULL,
    nombre          TEXT NOT NULL DEFAULT '',
    entradas        INTEGER NOT NULL,
    salidas         INTEGER NOT NULL,
    datos           TEXT NOT NULL DEFAULT '{}',
    notas           TEXT NOT NULL DEFAULT '',
    creado          TEXT NOT NULL,
    creado_por      TEXT,
    modificado      TEXT NOT NULL,
    modificado_por  TEXT,
    version         INTEGER NOT NULL,
    borrado         TEXT
);
CREATE INDEX IF NOT EXISTS equipos_red_version ON equipos(red_id, version);
CREATE INDEX IF NOT EXISTS equipos_elemento ON equipos(elemento_id);

-- Uniones (fusiones o conectores) entre dos extremos dentro de un elemento.
CREATE TABLE IF NOT EXISTS fusiones (
    id              INTEGER PRIMARY KEY,
    red_id          INTEGER NOT NULL REFERENCES redes(id),
    elemento_id     INTEGER NOT NULL REFERENCES elementos(id),
    a               TEXT NOT NULL,
    b               TEXT NOT NULL,
    tipo            TEXT NOT NULL DEFAULT 'fusion',
    notas           TEXT NOT NULL DEFAULT '',
    creado          TEXT NOT NULL,
    creado_por      TEXT,
    modificado      TEXT NOT NULL,
    modificado_por  TEXT,
    version         INTEGER NOT NULL,
    borrado         TEXT
);
CREATE INDEX IF NOT EXISTS fusiones_red_version ON fusiones(red_id, version);
CREATE INDEX IF NOT EXISTS fusiones_elemento ON fusiones(elemento_id);
""",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def haversine_m(a, b) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(h)))


def line_length_m(coords) -> float:
    return sum(haversine_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def lados_en(nodos: list, elemento_id: int) -> set:
    """Lados del cable que hay en un elemento: 'a' (el tramo hacia el comienzo) si
    el cable no empieza ahí, 'b' (hacia el final) si no termina ahí. Si pasa más
    de una vez, cuentan la primera entrada y la última salida."""
    pos = [i for i, n in enumerate(nodos) if n == elemento_id]
    if not pos:
        return set()
    out = set()
    if pos[0] > 0:
        out.add("a")
    if pos[-1] < len(nodos) - 1:
        out.add("b")
    return out


def parse_extremo(value):
    """'c12:a:5' -> ('c', 12, 'a', 5); 'q3:s:2' -> ('q', 3, 's', 2)."""
    if isinstance(value, str):
        for kind, pattern in (("c", EXTREMO_CABLE), ("q", EXTREMO_EQUIPO)):
            m = pattern.fullmatch(value)
            if m and int(m[1]) <= MAX_ENTERO:
                return kind, int(m[1]), m[2], int(m[3])
    shown = value[:40] if isinstance(value, str) else type(value).__name__
    raise ApiError(HTTPStatus.BAD_REQUEST, f"Extremo inválido: {shown}.")


class Store:
    """Acceso a la base. Una conexión por hilo; cada escritura va en una transacción."""

    def __init__(self, path: str):
        self.path = path
        self.local = threading.local()
        self.migrate()
        # Sin conexiones abiertas entre pedidos, SQLite vuelca el WAL a la base
        # al cerrar la última: red.db queda completa por sí sola.
        self.close()

    def conn(self) -> sqlite3.Connection:
        c = getattr(self.local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=10, isolation_level=None)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA foreign_keys=ON")
            c.execute("PRAGMA busy_timeout=10000")
            self.local.conn = c
        return c

    def close(self):
        """Cierra la conexión del hilo actual (cada pedido corre en un hilo propio)."""
        c = getattr(self.local, "conn", None)
        if c is not None:
            self.local.conn = None
            c.close()

    def migrate(self):
        c = self.conn()
        actual = c.execute("PRAGMA user_version").fetchone()[0]
        if actual > ESQUEMA:
            raise SystemExit(f"La base {self.path} es de una versión más nueva ({actual}) que este programa ({ESQUEMA}).")
        for numero in range(actual + 1, ESQUEMA + 1):
            c.execute("BEGIN IMMEDIATE")
            try:
                for sentencia in MIGRACIONES[numero].split(";\n"):
                    if sentencia.strip():
                        c.execute(sentencia)
                c.execute(f"PRAGMA user_version = {numero}")
                c.execute("COMMIT")
            except Exception:
                c.execute("ROLLBACK")
                raise
            log.info("base %s: esquema %d aplicado", self.path, numero)

    # --- transacciones y versión
    def begin(self):
        self.conn().execute("BEGIN IMMEDIATE")

    def commit(self):
        self.conn().execute("COMMIT")

    def rollback(self):
        try:
            self.conn().execute("ROLLBACK")
        except sqlite3.Error:
            pass

    def version(self) -> int:
        return self.conn().execute("SELECT valor FROM meta WHERE clave = 'version'").fetchone()["valor"]

    def next_version(self) -> int:
        c = self.conn()
        c.execute("UPDATE meta SET valor = valor + 1 WHERE clave = 'version'")
        return self.version()

    def log_change(self, red_id, usuario, accion, tabla, registro_id, detalle):
        self.conn().execute(
            "INSERT INTO historial (red_id, fecha, usuario, accion, tabla, registro_id, detalle) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (red_id, now_iso(), usuario, accion, tabla, registro_id, json.dumps(detalle, ensure_ascii=False)),
        )
        log.info("%s %s %s %d (red %d)", usuario, accion, tabla, registro_id, red_id)

    # --- redes
    def networks(self):
        rows = self.conn().execute(
            "SELECT r.id, r.nombre, r.creado, r.creado_por, "
            "(SELECT COUNT(*) FROM elementos e WHERE e.red_id = r.id AND e.borrado IS NULL) AS elementos, "
            "(SELECT COUNT(*) FROM cables c WHERE c.red_id = r.id AND c.borrado IS NULL) AS cables "
            "FROM redes r ORDER BY r.nombre COLLATE NOCASE"
        ).fetchall()
        return [dict(r) for r in rows]

    def red_de(self, tabla: str, registro_id: int):
        """La red de un elemento, cable, equipo o unión (aunque esté borrado); None si no existe."""
        consultas = {
            "elementos": "SELECT red_id FROM elementos WHERE id = ?",
            "cables": "SELECT red_id FROM cables WHERE id = ?",
            "equipos": "SELECT e.red_id FROM equipos q JOIN elementos e ON e.id = q.elemento_id WHERE q.id = ?",
            "fusiones": "SELECT e.red_id FROM fusiones f JOIN elementos e ON e.id = f.elemento_id WHERE f.id = ?",
        }
        row = self.conn().execute(consultas[tabla], (registro_id,)).fetchone()
        return row["red_id"] if row else None

    def network_info(self, red_id: int):
        row = self.conn().execute("SELECT id, nombre, creado, creado_por FROM redes WHERE id = ?", (red_id,)).fetchone()
        return dict(row) if row else None

    def add_network(self, nombre: str, usuario: str):
        self.begin()
        try:
            cur = self.conn().execute(
                "INSERT INTO redes (nombre, creado, creado_por) VALUES (?, ?, ?)", (nombre, now_iso(), usuario)
            )
            red_id = cur.lastrowid
            self.log_change(red_id, usuario, "crear", "redes", red_id, {"nombre": nombre})
            self.commit()
        except sqlite3.IntegrityError:
            self.rollback()
            raise ApiError(HTTPStatus.CONFLICT, "Ya existe una red con ese nombre.")
        except Exception:
            self.rollback()
            raise
        return self.network_info(red_id)

    def rename_network(self, red_id: int, nombre: str, usuario: str):
        self.begin()
        try:
            antes = self.network_info(red_id)
            if antes is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "No existe esa red.")
            self.conn().execute("UPDATE redes SET nombre = ? WHERE id = ?", (nombre, red_id))
            self.log_change(red_id, usuario, "editar", "redes", red_id, {"nombre": nombre, "antes": antes["nombre"]})
            self.commit()
        except sqlite3.IntegrityError:
            self.rollback()
            raise ApiError(HTTPStatus.CONFLICT, "Ya existe una red con ese nombre.")
        except Exception:
            self.rollback()
            raise
        return self.network_info(red_id)

    # --- lectura de la red
    @staticmethod
    def element_feature(row) -> dict:
        return {
            "type": "Feature",
            "id": row["id"],
            "geometry": {"type": "Point", "coordinates": [row["lon"], row["lat"]]},
            "properties": {
                "id": row["id"],
                "red": row["red_id"],
                "tipo": row["tipo"],
                "nombre": row["nombre"],
                "estado": row["estado"],
                "datos": json.loads(row["datos"] or "{}"),
                "carta": json.loads(row["carta"] or "{}"),
                "notas": row["notas"],
                "creado": row["creado"],
                "creado_por": row["creado_por"],
                "modificado": row["modificado"],
                "modificado_por": row["modificado_por"],
                "version": row["version"],
            },
        }

    @staticmethod
    def cable_feature(row) -> dict:
        return {
            "type": "Feature",
            "id": row["id"],
            "geometry": {"type": "LineString", "coordinates": json.loads(row["coords"])},
            "properties": {
                "id": row["id"],
                "red": row["red_id"],
                "tipo": row["tipo"],
                "nombre": row["nombre"],
                "fibras": row["fibras"],
                "por_tubo": row["por_tubo"],
                "colores": row["colores"],
                "estado": row["estado"],
                "tendido": row["tendido"],
                "largo_m": round(row["largo_m"], 1),
                "nodos": json.loads(row["nodos"]),
                "datos": json.loads(row["datos"] or "{}"),
                "notas": row["notas"],
                "creado": row["creado"],
                "creado_por": row["creado_por"],
                "modificado": row["modificado"],
                "modificado_por": row["modificado_por"],
                "version": row["version"],
            },
        }

    @staticmethod
    def equipo_json(row) -> dict:
        return {
            "id": row["id"],
            "red": row["red_id"],
            "elemento": row["elemento_id"],
            "tipo": row["tipo"],
            "nombre": row["nombre"],
            "entradas": row["entradas"],
            "salidas": row["salidas"],
            "datos": json.loads(row["datos"] or "{}"),
            "notas": row["notas"],
            "creado": row["creado"],
            "creado_por": row["creado_por"],
            "modificado": row["modificado"],
            "modificado_por": row["modificado_por"],
            "version": row["version"],
        }

    @staticmethod
    def fusion_json(row) -> dict:
        return {
            "id": row["id"],
            "red": row["red_id"],
            "elemento": row["elemento_id"],
            "a": row["a"],
            "b": row["b"],
            "tipo": row["tipo"],
            "notas": row["notas"],
            "creado": row["creado"],
            "creado_por": row["creado_por"],
            "modificado": row["modificado"],
            "modificado_por": row["modificado_por"],
            "version": row["version"],
        }

    @staticmethod
    def tombstone(row) -> dict:
        out = {"id": row["id"], "red": row["red_id"], "borrado": True, "modificado_por": row["modificado_por"], "version": row["version"]}
        if "elemento_id" in row.keys():
            out["elemento"] = row["elemento_id"]
        return out

    def network(self, red_id) -> dict:
        """Toda una red; con red_id None, todas juntas (la vista de quien administra)."""
        c = self.conn()
        filtro, params = ("red_id = ? AND", (red_id,)) if red_id is not None else ("", ())
        # Lectura consistente: todo de un mismo momento.
        c.execute("BEGIN")
        try:
            version = self.version()
            rows = {
                tabla: c.execute(
                    f"SELECT * FROM {tabla} WHERE {filtro} borrado IS NULL ORDER BY id", params
                ).fetchall()
                for tabla in ("elementos", "cables", "equipos", "fusiones")
            }
        finally:
            c.execute("COMMIT")
        return {
            "version": version,
            "elementos": {"type": "FeatureCollection", "features": [self.element_feature(r) for r in rows["elementos"]]},
            "cables": {"type": "FeatureCollection", "features": [self.cable_feature(r) for r in rows["cables"]]},
            "equipos": [self.equipo_json(r) for r in rows["equipos"]],
            "fusiones": [self.fusion_json(r) for r in rows["fusiones"]],
        }

    def changes(self, red_id, since: int) -> dict:
        c = self.conn()
        filtro, params = ("red_id = ? AND", (red_id, since)) if red_id is not None else ("", (since,))
        c.execute("BEGIN")
        try:
            version = self.version()
            rows = {
                tabla: c.execute(
                    f"SELECT * FROM {tabla} WHERE {filtro} version > ? ORDER BY version, id", params
                ).fetchall()
                for tabla in ("elementos", "cables", "equipos", "fusiones")
            }
        finally:
            c.execute("COMMIT")
        vivo = {
            "elementos": self.element_feature,
            "cables": self.cable_feature,
            "equipos": self.equipo_json,
            "fusiones": self.fusion_json,
        }
        out = {"version": version}
        for tabla, fn in vivo.items():
            out[tabla] = [self.tombstone(r) if r["borrado"] else fn(r) for r in rows[tabla]]
        return out

    def history(self, red_id: int, limit: int):
        rows = self.conn().execute(
            "SELECT id, fecha, usuario, accion, tabla, registro_id, detalle FROM historial WHERE red_id = ? "
            "ORDER BY id DESC LIMIT ?",
            (red_id, limit),
        ).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["detalle"] = json.loads(item["detalle"] or "{}")
            out.append(item)
        return out

    # --- control de concurrencia
    def check_version(self, row, expected, feature_fn):
        """Si el usuario editó una versión vieja, 409 con lo que hay ahora."""
        if expected is not None and expected != row["version"]:
            raise ApiError(
                HTTPStatus.CONFLICT,
                f"Mientras lo tenías abierto, {row['modificado_por'] or 'otro usuario'} lo cambió. "
                "Se cargó la versión actual: revisala y volvé a guardar.",
                {"actual": feature_fn(row)},
            )

    # --- uniones: utilidades
    def _live_fusions(self, where: str, params) -> list:
        return self.conn().execute(f"SELECT * FROM fusiones WHERE borrado IS NULL AND {where} ORDER BY id", params).fetchall()

    def _cable_fusions(self, cable_id: int) -> list:
        """Uniones vivas que usan alguna fibra de un cable (en cualquier elemento)."""
        patron = f"c{cable_id}:%"
        return self._live_fusions("(a LIKE ? OR b LIKE ?)", (patron, patron))

    def _drop_fusions(self, rows, version, t, usuario) -> list:
        """Baja lógica de uniones; devuelve las lápidas para el visor."""
        out = []
        for r in rows:
            self.conn().execute(
                "UPDATE fusiones SET borrado = ?, modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                (t, t, usuario, version, r["id"]),
            )
            out.append({"id": r["id"], "borrado": True, "elemento": r["elemento_id"], "modificado_por": usuario,
                        "version": version})
        return out

    def _names(self, element_ids) -> str:
        ids = sorted(set(element_ids))
        if not ids:
            return ""
        marks = ",".join("?" * len(ids))
        rows = self.conn().execute(f"SELECT id, nombre, tipo FROM elementos WHERE id IN ({marks})", ids).fetchall()
        nombres = [r["nombre"] or r["tipo"] for r in rows]
        if len(nombres) <= 1:
            return "".join(nombres)
        return ", ".join(nombres[:-1]) + " y " + nombres[-1]

    # --- elementos
    def get_element(self, element_id: int):
        return self.conn().execute("SELECT * FROM elementos WHERE id = ? AND borrado IS NULL", (element_id,)).fetchone()

    def add_element(self, red_id: int, fields: dict, usuario: str) -> dict:
        t = now_iso()
        self.begin()
        try:
            v = self.next_version()
            cur = self.conn().execute(
                "INSERT INTO elementos (red_id, tipo, nombre, estado, lon, lat, datos, carta, notas, creado, creado_por, "
                "modificado, modificado_por, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    red_id, fields["tipo"], fields.get("nombre", ""), fields.get("estado", "instalado"),
                    fields["lon"], fields["lat"], json.dumps(fields.get("datos", {}), ensure_ascii=False),
                    json.dumps(merge_carta({}, fields.get("carta", {}))), fields.get("notas", ""), t, usuario, t, usuario, v,
                ),
            )
            element_id = cur.lastrowid
            self.log_change(red_id, usuario, "crear", "elementos", element_id,
                            {"tipo": fields["tipo"], "nombre": fields.get("nombre", "")})
            out = {"elemento": self.element_feature(self.get_element(element_id)), "version": v}
            self.commit()
        except Exception:
            self.rollback()
            raise
        return out

    def _insertar(self, red_id: int, fields: dict, usuario: str, t: str, version: int, origen: str = None,
                  lote: int = None) -> int:
        cur = self.conn().execute(
            "INSERT INTO elementos (red_id, tipo, nombre, estado, lon, lat, datos, carta, notas, creado, creado_por, "
            "modificado, modificado_por, version) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)",
            (red_id, fields["tipo"], fields.get("nombre", ""), fields.get("estado", "instalado"), fields["lon"],
             fields["lat"], json.dumps(fields.get("datos", {}), ensure_ascii=False), fields.get("notas", ""),
             t, usuario, t, usuario, version),
        )
        detalle = {"tipo": fields["tipo"], "nombre": fields.get("nombre", "")}
        if origen:
            detalle["origen"] = origen
        if lote:
            detalle["lote"] = lote  # para deshacer una importación entera
        self.log_change(red_id, usuario, "crear", "elementos", cur.lastrowid, detalle)
        return cur.lastrowid

    def importar_elementos(self, red_id: int, preparar, usuario: str, origen: str = None, lote: bool = False) -> dict:
        """Agrega los elementos que calcula preparar(), que lee la base dentro de la misma
        transacción: dos pedidos a la vez no agregan dos veces lo mismo. preparar
        devuelve (nuevos, extra); todos van con una sola versión. Con lote=True, esa
        versión queda en el historial como número de la importación (para deshacerla)."""
        t = now_iso()
        self.begin()
        try:
            nuevos, extra = preparar()
            if nuevos:
                v = self.next_version()
                ids = [self._insertar(red_id, f, usuario, t, v, origen, lote=v if lote else None) for f in nuevos]
                out = {"elementos": [self.element_feature(self.get_element(i)) for i in ids], "version": v}
            else:
                out = {"elementos": [], "version": self.version()}
            self.commit()
        except Exception:
            self.rollback()
            raise
        out.update(extra)
        return out

    def importar_clientes(self, red_id: int, preparar, usuario: str, origen: str = None) -> dict:
        """Agrega los clientes que calcula preparar(clientes de la red); devuelve (nuevos, omitidos)."""
        def todo():
            nuevos, omitidos = preparar(self.clientes_red(red_id))
            return nuevos, {"omitidos": omitidos}
        return self.importar_elementos(red_id, todo, usuario, origen)

    def ultima_importacion(self, red_id: int):
        """La última importación de la red de la que queda algo en el mapa:
        {"version", "fecha", "usuario", "elementos"} o None."""
        row = self.conn().execute(
            "SELECT json_extract(h.detalle, '$.lote') AS lote, MIN(h.fecha) AS fecha, MIN(h.usuario) AS usuario, "
            "COUNT(*) AS elementos FROM historial h JOIN elementos e ON e.id = h.registro_id AND e.borrado IS NULL "
            "WHERE h.red_id = ? AND h.tabla = 'elementos' AND h.accion = 'crear' "
            "AND json_extract(h.detalle, '$.lote') IS NOT NULL GROUP BY lote ORDER BY lote DESC LIMIT 1",
            (red_id,)).fetchone()
        if row is None:
            return None
        return {"version": row["lote"], "fecha": row["fecha"], "usuario": row["usuario"], "elementos": row["elementos"]}

    def deshacer_importacion(self, red_id: int, lote: int, usuario: str) -> dict:
        """Quita lo que agregó una importación (la de la versión `lote`), salvo lo que se
        tocó después o lo que ya tiene cables, equipos o uniones."""
        self.begin()
        try:
            ids = [r["registro_id"] for r in self.conn().execute(
                "SELECT registro_id FROM historial WHERE red_id = ? AND tabla = 'elementos' AND accion = 'crear' "
                "AND json_extract(detalle, '$.lote') = ?", (red_id, lote))]
            if not ids:
                raise ApiError(HTTPStatus.NOT_FOUND, "No hay una importación con ese número en esta red.")
            out = self._quitar_importados(red_id, {i: lote for i in ids}, usuario, "deshacer importación")
            self.commit()
        except Exception:
            self.rollback()
            raise
        return out

    def quitar_importados(self, red_id: int, ids, usuario: str, origen: str) -> dict:
        """Quita, de estos elementos, los que agregó una importación y siguen como quedaron
        (lo dibujado a mano, lo que se tocó después o tiene cables, equipos o uniones, queda)."""
        self.begin()
        try:
            lotes = {i: None for i in ids}
            lista = list(lotes)
            for k in range(0, len(lista), 500):
                parte = lista[k:k + 500]
                for r in self.conn().execute(
                        "SELECT registro_id, json_extract(detalle, '$.lote') AS lote FROM historial WHERE red_id = ? "
                        f"AND tabla = 'elementos' AND accion = 'crear' AND registro_id IN ({','.join('?' * len(parte))})",
                        (red_id, *parte)):
                    if r["lote"] is not None:
                        lotes[r["registro_id"]] = r["lote"]
            out = self._quitar_importados(red_id, lotes, usuario, origen)
            self.commit()
        except Exception:
            self.rollback()
            raise
        return out

    def _quitar_importados(self, red_id: int, lotes: dict, usuario: str, origen: str) -> dict:
        """Dentro de una transacción: quita los elementos de `lotes` ({id: número de la
        importación que lo agregó, o None}) que siguen con la versión de su importación y
        no tienen cables, equipos ni uniones. Todo lo quitado va en una versión."""
        v, t = None, now_iso()
        quitados, quedan = [], 0
        for element_id, lote in lotes.items():
            row = self.get_element(element_id)
            if row is None or row["red_id"] != red_id:
                continue  # ya se borró
            ocupado = (self._attached_cables(element_id)
                       or self.conn().execute("SELECT 1 FROM equipos WHERE elemento_id = ? AND borrado IS NULL LIMIT 1",
                                              (element_id,)).fetchone()
                       or self.conn().execute("SELECT 1 FROM fusiones WHERE elemento_id = ? AND borrado IS NULL LIMIT 1",
                                              (element_id,)).fetchone())
            if lote is None or row["version"] != lote or ocupado:
                quedan += 1
                continue
            if v is None:
                v = self.next_version()
            self.conn().execute(
                "UPDATE elementos SET borrado = ?, modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                (t, t, usuario, v, element_id))
            self.log_change(red_id, usuario, "borrar", "elementos", element_id,
                            {"tipo": row["tipo"], "nombre": row["nombre"], "antes": self.element_feature(row),
                             "origen": origen, "lote": lote})
            quitados.append({"id": element_id, "borrado": True, "modificado_por": usuario, "version": v})
        return {"elementos": quitados, "version": v if v is not None else self.version(),
                "quitados": len(quitados), "quedan": quedan}

    def vincular_cliente(self, element_id: int, item: dict, usuario: str, vigentes=()) -> dict:
        """Anota en un cliente su contrato de Wispro (y lo que le falte: abonado, ONT,
        dirección; lo que se completó queda anotado, para deshacerlo). Un contrato va
        con un solo cliente, y un cliente con un solo contrato de los que siguen en
        Wispro (vigentes): si no, 409."""
        cid = item["id"].lower()
        self.begin()
        try:
            row = self.get_element(element_id)
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese cliente ya no existe: lo borró otro usuario.")
            datos = datos_de(row)
            antes = str(datos.get("wispro_contrato") or "").lower()
            if antes and antes != cid and antes in vigentes:
                raise ApiError(HTTPStatus.CONFLICT, f"{row['nombre'] or 'Este cliente'} ya está vinculado con otro contrato de "
                               "Wispro. Si ese no es el suyo, primero tocá «No es su contrato» en su ficha.")
            for otro in self.clientes_red(row["red_id"]):
                if otro["id"] != element_id and str(datos_de(otro).get("wispro_contrato") or "").lower() == cid:
                    nombre = otro["nombre"] or "otro cliente"
                    raise ApiError(HTTPStatus.CONFLICT, f"Ese contrato ya está vinculado con {nombre}. Si no es ese, primero "
                                   f"tocá «No es su contrato» en la ficha de {nombre}.")
            llenados = []
            if item["numero"] is not None and str(datos.get("contrato") or "").strip().lstrip("#").strip() != str(item["numero"]):
                datos["contrato"] = str(item["numero"])
                llenados.append("contrato")
            for k, valor in (("abonado", item["cliente_numero"]), ("ont", item["sn"]), ("direccion", item["direccion"])):
                if valor not in (None, "") and not datos.get(k):
                    datos[k] = str(valor)
                    llenados.append(k)
            previos = [k for k in str(datos.get("wispro_llenados") or "").split(",") if k] if antes == cid else []
            datos["wispro_llenados"] = ",".join(dict.fromkeys(previos + llenados))
            datos["wispro_contrato"] = item["id"]
            datos["wispro_no"] = ",".join(u for u in lista_uuid(datos.get("wispro_no")) if u != cid)
            return self._guardar_datos(row, datos, usuario)
        except Exception:
            self.rollback()
            raise

    def desvincular_cliente(self, element_id: int, contrato_id: str, item, usuario: str, deshacer: bool = False) -> dict:
        """El cliente no es el de ese contrato: se quita el vínculo y lo que el vínculo
        había completado (si sigue igual), y se anota para no volver a proponerlo.
        Con deshacer=True solo se borra esa anotación (un «No es» tocado sin querer)."""
        cid = contrato_id.lower()
        self.begin()
        try:
            row = self.get_element(element_id)
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese cliente ya no existe: lo borró otro usuario.")
            datos = datos_de(row)
            if deshacer:
                datos["wispro_no"] = ",".join(u for u in lista_uuid(datos.get("wispro_no")) if u != cid)
                return self._guardar_datos(row, datos, usuario)
            if str(datos.get("wispro_contrato") or "").lower() == cid:
                valores = {} if item is None else {"contrato": item["numero"], "abonado": item["cliente_numero"],
                                                   "ont": item["sn"], "direccion": item["direccion"],
                                                   "nap_puerto": datos.get("nap_puerto")}
                for k in str(datos.get("wispro_llenados") or "").split(","):
                    if k in valores and valores[k] not in (None, "") and str(datos.get(k) or "") == str(valores[k]):
                        datos.pop(k, None)
                datos.pop("wispro_contrato", None)
                datos.pop("wispro_llenados", None)
            no = [u for u in lista_uuid(datos.get("wispro_no")) if u != cid] + [cid]
            datos["wispro_no"] = ",".join(no[-10:])
            return self._guardar_datos(row, datos, usuario)
        except Exception:
            self.rollback()
            raise

    def _guardar_datos(self, row, datos: dict, usuario: str) -> dict:
        """Guarda los datos de un elemento dentro de la transacción abierta y la cierra."""
        datos = datos_field({"datos": datos})
        v = self.next_version()
        t = now_iso()
        self.conn().execute(
            "UPDATE elementos SET datos = ?, modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
            (json.dumps(datos, ensure_ascii=False), t, usuario, v, row["id"]))
        self.log_change(row["red_id"], usuario, "editar", "elementos", row["id"],
                        {"tipo": row["tipo"], "nombre": row["nombre"], "antes": self.element_feature(row), "origen": "wispro"})
        out = {"elemento": self.element_feature(self.get_element(row["id"])), "version": v}
        self.commit()
        return out

    def naps_red(self, red_id: int):
        """Las cajas NAP de una red, para saber cuáles de Wispro ya están en el mapa."""
        return self.conn().execute(
            "SELECT id, nombre, lon, lat, datos FROM elementos WHERE red_id = ? AND tipo = 'nap' AND borrado IS NULL",
            (red_id,),
        ).fetchall()

    def clientes_red(self, red_id: int):
        """Los clientes de una red, para cruzarlos con los contratos de Wispro."""
        return self.conn().execute(
            "SELECT id, nombre, lon, lat, datos FROM elementos WHERE red_id = ? AND tipo = 'cliente' AND borrado IS NULL",
            (red_id,),
        ).fetchall()

    def _check_new_type(self, row, tipo: str):
        """Un elemento con carta de empalme no puede pasar a ser de un tipo que no la tiene."""
        if tipo == row["tipo"]:
            return
        equipos = self.conn().execute(
            "SELECT tipo FROM equipos WHERE elemento_id = ? AND borrado IS NULL", (row["id"],)
        ).fetchall()
        uniones = self._live_fusions("elemento_id = ?", (row["id"],))
        nombre = row["nombre"] or row["tipo"]
        if tipo not in TIPOS_CON_CARTA and (equipos or uniones):
            raise ApiError(HTTPStatus.CONFLICT,
                           f"{nombre} tiene armada su carta de empalme ({len(uniones)} uniones, {len(equipos)} equipos): "
                           "quitalas antes de cambiarle el tipo.")
        if tipo != "nodo" and any(e["tipo"] == "olt" for e in equipos):
            raise ApiError(HTTPStatus.CONFLICT, f"{nombre} tiene una OLT, que solo va en un nodo: quitala antes de cambiarle el tipo.")
        if tipo in TIPOS_CON_CARTA and row["tipo"] not in TIPOS_CON_CARTA:
            for cable in self._attached_cables(row["id"]):
                if json.loads(cable["nodos"]).count(row["id"]) > 1:
                    raise ApiError(HTTPStatus.CONFLICT,
                                   f"El cable {cable['nombre'] or cable['id']} pasa dos veces por {nombre}: así no puede tener "
                                   "carta de empalme. Corregí ese cable antes de cambiarle el tipo.")

    def _solo_acomodado(self, row, expected) -> bool:
        """Si desde la versión que el usuario tenía a la vista el elemento solo
        cambió su disposición de carta ("ordenar"), editar sus datos no choca con
        eso: lo que se acomodó queda y lo editado también."""
        if expected is None or expected >= row["version"]:
            return False
        filas = self.conn().execute(
            "SELECT accion, detalle FROM historial WHERE tabla = 'elementos' AND registro_id = ? ORDER BY id DESC LIMIT 500",
            (row["id"],),
        ).fetchall()
        for h in filas:
            if h["accion"] != "ordenar":
                return False
            try:
                antes = json.loads(h["detalle"] or "{}").get("antes") or {}
            except ValueError:
                return False
            version = (antes.get("properties") or {}).get("version")
            if version == expected:
                return True
            if not isinstance(version, int) or version < expected:
                return False
        return False

    def update_element(self, element_id: int, fields: dict, expected, usuario: str) -> dict:
        self.begin()
        try:
            row = self.get_element(element_id)
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese elemento ya no existe: lo borró otro usuario.")
            if "carta" in fields or not self._solo_acomodado(row, expected):
                self.check_version(row, expected, self.element_feature)
            if "tipo" in fields:
                self._check_new_type(row, fields["tipo"])
            v = self.next_version()
            t = now_iso()
            merged = {
                "tipo": fields.get("tipo", row["tipo"]),
                "nombre": fields.get("nombre", row["nombre"]),
                "estado": fields.get("estado", row["estado"]),
                "lon": fields.get("lon", row["lon"]),
                "lat": fields.get("lat", row["lat"]),
                "datos": json.dumps(fields["datos"], ensure_ascii=False) if "datos" in fields else row["datos"],
                "carta": (json.dumps(merge_carta(json.loads(row["carta"] or "{}"), fields["carta"]))
                          if "carta" in fields else row["carta"]),
                "notas": fields.get("notas", row["notas"]),
            }
            self.conn().execute(
                "UPDATE elementos SET tipo = ?, nombre = ?, estado = ?, lon = ?, lat = ?, datos = ?, carta = ?, notas = ?, "
                "modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                (merged["tipo"], merged["nombre"], merged["estado"], merged["lon"], merged["lat"], merged["datos"],
                 merged["carta"], merged["notas"], t, usuario, v, element_id),
            )
            moved = (merged["lon"], merged["lat"]) != (row["lon"], row["lat"])
            cables = self._follow_element(element_id, [merged["lon"], merged["lat"]], v, t, usuario) if moved else []
            solo_carta = set(fields) == {"carta"}
            # Acomodar la carta pasa seguido: se anota solo la versión y la disposición anteriores.
            antes = ({"id": row["id"], "properties": {"version": row["version"], "carta": json.loads(row["carta"] or "{}")}}
                     if solo_carta else self.element_feature(row))
            self.log_change(row["red_id"], usuario,
                            "mover" if moved else ("ordenar" if solo_carta else "editar"), "elementos", element_id,
                            {"tipo": merged["tipo"], "nombre": merged["nombre"], "antes": antes})
            out = {"elemento": self.element_feature(self.get_element(element_id)), "cables": cables, "version": v}
            self.commit()
        except Exception:
            self.rollback()
            raise
        return out

    def delete_element(self, element_id: int, expected, usuario: str) -> dict:
        self.begin()
        try:
            row = self.get_element(element_id)
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese elemento ya no existe: lo borró otro usuario.")
            if not self._solo_acomodado(row, expected):
                self.check_version(row, expected, self.element_feature)
            v = self.next_version()
            t = now_iso()
            self.conn().execute(
                "UPDATE elementos SET borrado = ?, modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                (t, t, usuario, v, element_id),
            )
            cables = self._detach_element(element_id, v, t, usuario)
            # Con el elemento se va su carta de empalme: uniones y equipos.
            uniones = self._live_fusions("elemento_id = ?", (element_id,))
            fusiones = self._drop_fusions(uniones, v, t, usuario)
            equipos_rows = self.conn().execute(
                "SELECT * FROM equipos WHERE elemento_id = ? AND borrado IS NULL ORDER BY id", (element_id,)
            ).fetchall()
            equipos = []
            for e in equipos_rows:
                self.conn().execute(
                    "UPDATE equipos SET borrado = ?, modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                    (t, t, usuario, v, e["id"]),
                )
                equipos.append({"id": e["id"], "borrado": True, "elemento": element_id, "modificado_por": usuario,
                                "version": v})
            detalle = {"tipo": row["tipo"], "nombre": row["nombre"], "antes": self.element_feature(row)}
            if uniones or equipos_rows:
                detalle["carta"] = {"fusiones": [self.fusion_json(r) for r in uniones],
                                    "equipos": [self.equipo_json(r) for r in equipos_rows]}
            self.log_change(row["red_id"], usuario, "borrar", "elementos", element_id, detalle)
            self.commit()
        except Exception:
            self.rollback()
            raise
        return {"ok": True, "elementos": [{"id": element_id, "borrado": True, "modificado_por": usuario, "version": v}],
                "cables": cables, "fusiones": fusiones, "equipos": equipos, "version": v}

    def _attached_cables(self, element_id: int):
        return self.conn().execute(
            "SELECT c.* FROM cables c JOIN anclajes a ON a.cable_id = c.id "
            "WHERE a.elemento_id = ? AND c.borrado IS NULL ORDER BY c.id",
            (element_id,),
        ).fetchall()

    def _follow_element(self, element_id, lonlat, version, t, usuario):
        """Los puntos de cable pegados a un elemento se mueven con él."""
        out = []
        for row in self._attached_cables(element_id):
            coords = json.loads(row["coords"])
            nodos = json.loads(row["nodos"])
            for i, node in enumerate(nodos):
                if node == element_id:
                    coords[i] = lonlat
            self.conn().execute(
                "UPDATE cables SET coords = ?, largo_m = ?, modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                (json.dumps(coords), line_length_m(coords), t, usuario, version, row["id"]),
            )
            out.append(self.cable_feature(self.get_cable(row["id"])))
        return out

    def _detach_element(self, element_id, version, t, usuario):
        """Al borrar un elemento, los cables que pasaban por él quedan sueltos en ese punto."""
        out = []
        for row in self._attached_cables(element_id):
            nodos = [None if node == element_id else node for node in json.loads(row["nodos"])]
            self.conn().execute(
                "UPDATE cables SET nodos = ?, modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                (json.dumps(nodos), t, usuario, version, row["id"]),
            )
            out.append(self.cable_feature(self.get_cable(row["id"])))
        self.conn().execute("DELETE FROM anclajes WHERE elemento_id = ?", (element_id,))
        return out

    # --- cables
    def get_cable(self, cable_id: int):
        return self.conn().execute("SELECT * FROM cables WHERE id = ? AND borrado IS NULL", (cable_id,)).fetchone()

    def _anchor(self, red_id: int, coords: list, nodos: list):
        """Comprueba que cada punto pegado lo esté a un elemento vivo de la misma red y
        lo ubica exactamente sobre él (la posición del elemento manda)."""
        ids = sorted({n for n in nodos if n is not None})
        if not ids:
            return coords
        marks = ",".join("?" * len(ids))
        rows = self.conn().execute(
            f"SELECT id, lon, lat, tipo, nombre FROM elementos WHERE red_id = ? AND borrado IS NULL AND id IN ({marks})",
            (red_id, *ids),
        ).fetchall()
        where = {r["id"]: [r["lon"], r["lat"]] for r in rows}
        missing = [i for i in ids if i not in where]
        if missing:
            raise ApiError(HTTPStatus.CONFLICT,
                           "El cable pasa por un elemento que ya no existe (lo borró otro usuario).",
                           {"faltan": missing})
        # En la carta de empalme cada cable tiene un lado de entrada y uno de
        # salida por elemento: no puede pasar dos veces por la misma caja.
        for r in rows:
            if r["tipo"] in TIPOS_CON_CARTA and nodos.count(r["id"]) > 1:
                raise ApiError(HTTPStatus.BAD_REQUEST,
                               f"El cable pasa dos veces por {r['nombre'] or r['tipo']}. Si va y vuelve, "
                               "dibujalo como dos cables que empiezan o terminan ahí.")
        anchored = [where[n] if n is not None else coords[i] for i, n in enumerate(nodos)]
        if all(p == anchored[0] for p in anchored):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Los puntos del cable quedan todos en el mismo lugar.")
        return anchored

    def _save_anchors(self, cable_id: int, nodos: list):
        c = self.conn()
        c.execute("DELETE FROM anclajes WHERE cable_id = ?", (cable_id,))
        for element_id in sorted({n for n in nodos if n is not None}):
            c.execute("INSERT INTO anclajes (cable_id, elemento_id) VALUES (?, ?)", (cable_id, element_id))

    def add_cable(self, red_id: int, fields: dict, usuario: str) -> dict:
        t = now_iso()
        self.begin()
        try:
            coords = self._anchor(red_id, fields["coords"], fields["nodos"])
            v = self.next_version()
            cur = self.conn().execute(
                "INSERT INTO cables (red_id, tipo, nombre, fibras, por_tubo, colores, estado, tendido, coords, nodos, "
                "largo_m, datos, notas, creado, creado_por, modificado, modificado_por, version) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    red_id, fields.get("tipo", "distribucion"), fields.get("nombre", ""), fields.get("fibras", 12),
                    fields.get("por_tubo", 0), fields.get("colores", "tia598"),
                    fields.get("estado", "instalado"), fields.get("tendido", "aereo"), json.dumps(coords),
                    json.dumps(fields["nodos"]), line_length_m(coords),
                    json.dumps(fields.get("datos", {}), ensure_ascii=False), fields.get("notas", ""),
                    t, usuario, t, usuario, v,
                ),
            )
            cable_id = cur.lastrowid
            self._save_anchors(cable_id, fields["nodos"])
            self.log_change(red_id, usuario, "crear", "cables", cable_id,
                            {"tipo": fields.get("tipo", "distribucion"), "nombre": fields.get("nombre", "")})
            out = {"cable": self.cable_feature(self.get_cable(cable_id)), "version": v}
            self.commit()
        except Exception:
            self.rollback()
            raise
        return out

    def _check_cable_fusions(self, cable_id: int, fibras: int, nodos):
        """Un cambio de fibras o de trazado no puede dejar uniones colgando de una
        fibra o de un lado del cable que ya no existe."""
        sin_fibra, sin_lado = [], []
        for f in self._cable_fusions(cable_id):
            for ext in (f["a"], f["b"]):
                kind, ident, lado, n = parse_extremo(ext)
                if kind != "c" or ident != cable_id:
                    continue
                if n > fibras:
                    sin_fibra.append(f)
                elif nodos is not None and lado not in lados_en(nodos, f["elemento_id"]):
                    sin_lado.append(f)
        if sin_fibra:
            raise ApiError(HTTPStatus.CONFLICT,
                           f"Hay uniones en fibras que dejarían de existir (en {self._names(f['elemento_id'] for f in sin_fibra)}): "
                           "quitalas en la carta de empalme antes de bajar la cantidad de fibras.",
                           {"fusiones": [f["id"] for f in sin_fibra]})
        if sin_lado:
            raise ApiError(HTTPStatus.CONFLICT,
                           f"El cable tiene uniones en {self._names(f['elemento_id'] for f in sin_lado)} que con este "
                           "trazado quedarían sin cable: quitalas en la carta de empalme antes de sacarlo de ahí.",
                           {"fusiones": [f["id"] for f in sin_lado]})

    def update_cable(self, cable_id: int, fields: dict, expected, usuario: str) -> dict:
        self.begin()
        try:
            row = self.get_cable(cable_id)
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese cable ya no existe: lo borró otro usuario.")
            self.check_version(row, expected, self.cable_feature)
            if "coords" in fields:
                nodos = fields["nodos"]
                coords = self._anchor(row["red_id"], fields["coords"], nodos)
            else:
                coords, nodos = json.loads(row["coords"]), json.loads(row["nodos"])
            fibras = fields.get("fibras", row["fibras"])
            if fibras < row["fibras"] or "coords" in fields:
                self._check_cable_fusions(cable_id, fibras, nodos if "coords" in fields else None)
            if "coords" in fields:
                self._save_anchors(cable_id, nodos)
            v = self.next_version()
            t = now_iso()
            self.conn().execute(
                "UPDATE cables SET tipo = ?, nombre = ?, fibras = ?, por_tubo = ?, colores = ?, estado = ?, tendido = ?, "
                "coords = ?, nodos = ?, largo_m = ?, datos = ?, notas = ?, modificado = ?, modificado_por = ?, version = ? "
                "WHERE id = ?",
                (
                    fields.get("tipo", row["tipo"]), fields.get("nombre", row["nombre"]), fibras,
                    fields.get("por_tubo", row["por_tubo"]), fields.get("colores", row["colores"]),
                    fields.get("estado", row["estado"]), fields.get("tendido", row["tendido"]), json.dumps(coords),
                    json.dumps(nodos), line_length_m(coords),
                    json.dumps(fields["datos"], ensure_ascii=False) if "datos" in fields else row["datos"],
                    fields.get("notas", row["notas"]), t, usuario, v, cable_id,
                ),
            )
            self.log_change(row["red_id"], usuario, "trazar" if "coords" in fields else "editar", "cables", cable_id,
                            {"tipo": fields.get("tipo", row["tipo"]), "nombre": fields.get("nombre", row["nombre"]),
                             "antes": self.cable_feature(row)})
            out = {"cable": self.cable_feature(self.get_cable(cable_id)), "version": v}
            self.commit()
        except Exception:
            self.rollback()
            raise
        return out

    def delete_cable(self, cable_id: int, expected, usuario: str) -> dict:
        self.begin()
        try:
            row = self.get_cable(cable_id)
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese cable ya no existe: lo borró otro usuario.")
            self.check_version(row, expected, self.cable_feature)
            v = self.next_version()
            t = now_iso()
            self.conn().execute(
                "UPDATE cables SET borrado = ?, modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                (t, t, usuario, v, cable_id),
            )
            self.conn().execute("DELETE FROM anclajes WHERE cable_id = ?", (cable_id,))
            uniones = self._cable_fusions(cable_id)
            fusiones = self._drop_fusions(uniones, v, t, usuario)
            detalle = {"tipo": row["tipo"], "nombre": row["nombre"], "antes": self.cable_feature(row)}
            if uniones:
                detalle["fusiones"] = [self.fusion_json(r) for r in uniones]
            self.log_change(row["red_id"], usuario, "borrar", "cables", cable_id, detalle)
            self.commit()
        except Exception:
            self.rollback()
            raise
        return {"ok": True, "cables": [{"id": cable_id, "borrado": True, "modificado_por": usuario, "version": v}],
                "fusiones": fusiones, "version": v}

    # --- equipos (splitters y OLT)
    def get_equipo(self, equipo_id: int):
        return self.conn().execute("SELECT * FROM equipos WHERE id = ? AND borrado IS NULL", (equipo_id,)).fetchone()

    @staticmethod
    def _check_equipo(elemento, eq: dict):
        """Combinaciones válidas de tipo, puertos y datos, y dónde puede ir cada equipo."""
        nombre = elemento["nombre"] or elemento["tipo"]
        if elemento["tipo"] not in TIPOS_CON_CARTA:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"{nombre} no lleva equipos: solo nodos, cajas, NAP y botellas.")
        datos = eq["datos"]
        if eq["tipo"] == "olt":
            if elemento["tipo"] != "nodo":
                raise ApiError(HTTPStatus.BAD_REQUEST, "Una OLT va en un nodo.")
            if eq["entradas"] != 0 or not 1 <= eq["salidas"] <= MAX_PUERTOS_OLT:
                raise ApiError(HTTPStatus.BAD_REQUEST, f"Una OLT tiene de 1 a {MAX_PUERTOS_OLT} puertos PON.")
            potencia = datos.get("potencia")
            if potencia is not None and (isinstance(potencia, (bool, str)) or not -10 <= potencia <= 15):
                raise ApiError(HTTPStatus.BAD_REQUEST, "La potencia de la OLT va de -10 a 15 dBm.")
            return
        modo = datos.get("modo", "plc")
        if modo not in MODOS_SPLITTER:
            raise ApiError(HTTPStatus.BAD_REQUEST, "El splitter es PLC (balanceado) o FBT (desbalanceado).")
        if modo == "plc":
            if eq["entradas"] not in (1, 2) or eq["salidas"] not in SALIDAS_PLC:
                raise ApiError(HTTPStatus.BAD_REQUEST,
                               "Un splitter PLC tiene 1 o 2 entradas y 2, 4, 8, 16, 32, 64 o 128 salidas.")
            if "relacion" in datos:
                raise ApiError(HTTPStatus.BAD_REQUEST, "La relación de potencias es solo para splitters desbalanceados.")
        else:
            m = RELACION_FBT.fullmatch(str(datos.get("relacion", "")))
            if eq["entradas"] != 1 or eq["salidas"] != 2 or not m or int(m[1]) + int(m[2]) != 100:
                raise ApiError(HTTPStatus.BAD_REQUEST,
                               "Un splitter desbalanceado tiene 1 entrada, 2 salidas y una relación como 10/90.")
        if "conectores" in datos and not isinstance(datos["conectores"], bool):
            raise ApiError(HTTPStatus.BAD_REQUEST, "conectores tiene que ser sí o no.")

    def add_equipo(self, element_id: int, fields: dict, usuario: str) -> dict:
        t = now_iso()
        self.begin()
        try:
            elemento = self.get_element(element_id)
            if elemento is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese elemento ya no existe: lo borró otro usuario.")
            eq = {
                "tipo": fields["tipo"],
                "nombre": fields.get("nombre", ""),
                "entradas": fields.get("entradas", 0 if fields["tipo"] == "olt" else 1),
                "salidas": fields.get("salidas", 16 if fields["tipo"] == "olt" else 8),
                "datos": fields.get("datos", {}),
                "notas": fields.get("notas", ""),
            }
            self._check_equipo(elemento, eq)
            v = self.next_version()
            cur = self.conn().execute(
                "INSERT INTO equipos (red_id, elemento_id, tipo, nombre, entradas, salidas, datos, notas, creado, creado_por, "
                "modificado, modificado_por, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (elemento["red_id"], element_id, eq["tipo"], eq["nombre"], eq["entradas"], eq["salidas"],
                 json.dumps(eq["datos"], ensure_ascii=False), eq["notas"], t, usuario, t, usuario, v),
            )
            equipo_id = cur.lastrowid
            self.log_change(elemento["red_id"], usuario, "crear", "equipos", equipo_id,
                            {"tipo": eq["tipo"], "nombre": eq["nombre"], "elemento": element_id})
            out = {"equipos": [self.equipo_json(self.get_equipo(equipo_id))], "version": v}
            self.commit()
        except Exception:
            self.rollback()
            raise
        return out

    def update_equipo(self, equipo_id: int, fields: dict, expected, usuario: str) -> dict:
        self.begin()
        try:
            row = self.get_equipo(equipo_id)
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese equipo ya no existe: lo borró otro usuario.")
            self.check_version(row, expected, self.equipo_json)
            if "tipo" in fields and fields["tipo"] != row["tipo"]:
                raise ApiError(HTTPStatus.BAD_REQUEST, "El tipo de equipo no se cambia: borralo y agregá otro.")
            elemento = self.get_element(row["elemento_id"])
            eq = {
                "tipo": row["tipo"],
                "nombre": fields.get("nombre", row["nombre"]),
                "entradas": fields.get("entradas", row["entradas"]),
                "salidas": fields.get("salidas", row["salidas"]),
                "datos": fields["datos"] if "datos" in fields else json.loads(row["datos"] or "{}"),
                "notas": fields.get("notas", row["notas"]),
            }
            self._check_equipo(elemento, eq)
            # Achicar un equipo no puede dejar uniones en puertos que ya no existen.
            colgadas = []
            for f in self._live_fusions("elemento_id = ? AND (a LIKE ? OR b LIKE ?)",
                                        (row["elemento_id"], f"q{equipo_id}:%", f"q{equipo_id}:%")):
                for ext in (f["a"], f["b"]):
                    kind, ident, lado, n = parse_extremo(ext)
                    if kind == "q" and ident == equipo_id and n > (eq["entradas"] if lado == "e" else eq["salidas"]):
                        colgadas.append(f["id"])
            if colgadas:
                raise ApiError(HTTPStatus.CONFLICT,
                               "Hay uniones en puertos que dejarían de existir: quitalas antes de achicar el equipo.",
                               {"fusiones": colgadas})
            v = self.next_version()
            t = now_iso()
            self.conn().execute(
                "UPDATE equipos SET nombre = ?, entradas = ?, salidas = ?, datos = ?, notas = ?, modificado = ?, "
                "modificado_por = ?, version = ? WHERE id = ?",
                (eq["nombre"], eq["entradas"], eq["salidas"], json.dumps(eq["datos"], ensure_ascii=False), eq["notas"],
                 t, usuario, v, equipo_id),
            )
            self.log_change(row["red_id"], usuario, "editar", "equipos", equipo_id,
                            {"tipo": row["tipo"], "nombre": eq["nombre"], "antes": self.equipo_json(row)})
            out = {"equipos": [self.equipo_json(self.get_equipo(equipo_id))], "version": v}
            self.commit()
        except Exception:
            self.rollback()
            raise
        return out

    def delete_equipo(self, equipo_id: int, expected, usuario: str) -> dict:
        self.begin()
        try:
            row = self.get_equipo(equipo_id)
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese equipo ya no existe: lo borró otro usuario.")
            self.check_version(row, expected, self.equipo_json)
            v = self.next_version()
            t = now_iso()
            self.conn().execute(
                "UPDATE equipos SET borrado = ?, modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                (t, t, usuario, v, equipo_id),
            )
            uniones = self._live_fusions("elemento_id = ? AND (a LIKE ? OR b LIKE ?)",
                                         (row["elemento_id"], f"q{equipo_id}:%", f"q{equipo_id}:%"))
            fusiones = self._drop_fusions(uniones, v, t, usuario)
            self.log_change(row["red_id"], usuario, "borrar", "equipos", equipo_id,
                            {"tipo": row["tipo"], "nombre": row["nombre"], "antes": self.equipo_json(row),
                             "fusiones": [self.fusion_json(r) for r in uniones]})
            self.commit()
        except Exception:
            self.rollback()
            raise
        return {"ok": True,
                "equipos": [{"id": equipo_id, "borrado": True, "elemento": row["elemento_id"], "modificado_por": usuario,
                             "version": v}],
                "fusiones": fusiones, "version": v}

    # --- uniones
    def get_fusion(self, fusion_id: int):
        return self.conn().execute("SELECT * FROM fusiones WHERE id = ? AND borrado IS NULL", (fusion_id,)).fetchone()

    def _check_extremo(self, elemento, parsed, cables: dict, equipos: dict):
        """El extremo existe en este elemento: un lado de un cable que llega acá
        (y una fibra que el cable tiene) o un puerto de un equipo de acá."""
        kind, ident, lado, n = parsed
        if kind == "c":
            if ident not in cables:
                row = self.get_cable(ident)
                if row is None or row["red_id"] != elemento["red_id"]:
                    raise ApiError(HTTPStatus.CONFLICT, "Uno de los cables ya no existe (lo borró otro usuario).",
                                   {"recargar": True})
                cables[ident] = (row, lados_en(json.loads(row["nodos"]), elemento["id"]))
            row, lados = cables[ident]
            if lado not in lados:
                raise ApiError(HTTPStatus.CONFLICT,
                               f"El cable {row['nombre'] or ident} ya no llega a {elemento['nombre'] or 'este elemento'} así "
                               "(alguien cambió su trazado). Se cargó la carta actual.",
                               {"recargar": True})
            if n > row["fibras"]:
                raise ApiError(HTTPStatus.BAD_REQUEST, f"El cable {row['nombre'] or ident} tiene {row['fibras']} fibras.")
            return row
        if ident not in equipos:
            row = self.get_equipo(ident)
            if row is None or row["elemento_id"] != elemento["id"]:
                raise ApiError(HTTPStatus.CONFLICT, "Uno de los equipos ya no existe (lo borró otro usuario).",
                               {"recargar": True})
            equipos[ident] = row
        row = equipos[ident]
        limite = row["entradas"] if lado == "e" else row["salidas"]
        if n > limite:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"{row['nombre'] or 'El equipo'} no tiene ese puerto.")
        return row

    def add_fusiones(self, element_id: int, pares: list, tipo, usuario: str) -> dict:
        t = now_iso()
        self.begin()
        try:
            elemento = self.get_element(element_id)
            if elemento is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese elemento ya no existe: lo borró otro usuario.")
            if elemento["tipo"] not in TIPOS_CON_CARTA:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Solo los nodos, las cajas, las NAP y las botellas tienen carta de empalme.")
            cables, equipos, vistos, filas = {}, {}, set(), []
            for a, b in pares:
                pa, pb = parse_extremo(a), parse_extremo(b)
                if a == b:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Un extremo no se puede unir consigo mismo.")
                if pa[0] == "q" and pb[0] == "q" and pa[1] == pb[1]:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "No se pueden unir dos puertos del mismo equipo.")
                for ext in (a, b):
                    if ext in vistos:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Un mismo extremo aparece en dos uniones.")
                    vistos.add(ext)
                ra = self._check_extremo(elemento, pa, cables, equipos)
                rb = self._check_extremo(elemento, pb, cables, equipos)
                con_conector = any(
                    p[0] == "q" and json.loads(r["datos"] or "{}").get("conectores") for p, r in ((pa, ra), (pb, rb))
                )
                filas.append((a, b, tipo or ("conector" if con_conector else "fusion")))
            ocupadas = [f for f in self._live_fusions("elemento_id = ?", (element_id,))
                        if f["a"] in vistos or f["b"] in vistos]
            if ocupadas:
                quien = ocupadas[0]["creado_por"] or "otro usuario"
                raise ApiError(HTTPStatus.CONFLICT,
                               f"Una de esas fibras o puertos ya está unida (la unió {quien}). Se cargó la carta actual.",
                               {"fusiones": [self.fusion_json(f) for f in ocupadas]})
            v = self.next_version()
            ids = []
            for a, b, tipo_union in filas:
                cur = self.conn().execute(
                    "INSERT INTO fusiones (red_id, elemento_id, a, b, tipo, notas, creado, creado_por, modificado, "
                    "modificado_por, version) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)",
                    (elemento["red_id"], element_id, a, b, tipo_union, t, usuario, t, usuario, v),
                )
                ids.append(cur.lastrowid)
                self.log_change(elemento["red_id"], usuario, "crear", "fusiones", cur.lastrowid,
                                {"elemento": element_id, "a": a, "b": b, "tipo": tipo_union})
            marks = ",".join("?" * len(ids))
            rows = self.conn().execute(f"SELECT * FROM fusiones WHERE id IN ({marks}) ORDER BY id", ids).fetchall()
            out = {"fusiones": [self.fusion_json(r) for r in rows], "version": v}
            self.commit()
        except Exception:
            self.rollback()
            raise
        return out

    def delete_fusiones(self, ids: list, expected, usuario: str) -> dict:
        """Quita uniones. Con una sola y su versión, controla que nadie la haya
        cambiado; las que ya no existen se saltean (deshacer varias)."""
        self.begin()
        try:
            rows = [r for r in (self.get_fusion(i) for i in ids) if r is not None]
            if not rows and len(ids) == 1:
                raise ApiError(HTTPStatus.NOT_FOUND, "Esa unión ya no existe: la quitó otro usuario.")
            if expected is not None and len(rows) == 1:
                self.check_version(rows[0], expected, self.fusion_json)
            fusiones, v = [], None
            if rows:
                v = self.next_version()
                t = now_iso()
                fusiones = self._drop_fusions(rows, v, t, usuario)
                for r in rows:
                    self.log_change(r["red_id"], usuario, "borrar", "fusiones", r["id"],
                                    {"elemento": r["elemento_id"], "a": r["a"], "b": r["b"], "tipo": r["tipo"]})
            self.commit()
        except Exception:
            self.rollback()
            raise
        return {"ok": True, "fusiones": fusiones, "version": v if v is not None else self.version()}

    def update_fusion(self, fusion_id: int, cambios: dict, expected, usuario: str) -> dict:
        """Pasa una punta (o las dos) de una unión a otra fibra o puerto del
        mismo elemento, sin quitarla y volver a hacerla."""
        t = now_iso()
        self.begin()
        try:
            row = self.get_fusion(fusion_id)
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Esa unión ya no existe: la quitó otro usuario.")
            self.check_version(row, expected, self.fusion_json)
            elemento = self.get_element(row["elemento_id"])
            if elemento is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese elemento ya no existe: lo borró otro usuario.")
            a, b = cambios.get("a", row["a"]), cambios.get("b", row["b"])
            pa, pb = parse_extremo(a), parse_extremo(b)
            if a == b:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Un extremo no se puede unir consigo mismo.")
            if pa[0] == "q" and pb[0] == "q" and pa[1] == pb[1]:
                raise ApiError(HTTPStatus.BAD_REQUEST, "No se pueden unir dos puertos del mismo equipo.")
            cables, equipos = {}, {}
            ra = self._check_extremo(elemento, pa, cables, equipos)
            rb = self._check_extremo(elemento, pb, cables, equipos)
            nuevos = {x for x in (a, b) if x not in (row["a"], row["b"])}
            ocupadas = [f for f in self._live_fusions("elemento_id = ? AND id != ?", (row["elemento_id"], fusion_id))
                        if f["a"] in nuevos or f["b"] in nuevos]
            if ocupadas:
                quien = ocupadas[0]["creado_por"] or "otro usuario"
                raise ApiError(HTTPStatus.CONFLICT,
                               f"Esa fibra o puerto ya está unida (la unió {quien}). Se cargó la carta actual.",
                               {"fusiones": [self.fusion_json(f) for f in ocupadas]})
            if (a, b) == (row["a"], row["b"]):
                self.rollback()
                return {"fusiones": [self.fusion_json(row)], "version": self.version()}
            # Si en la unión hay (o había) un equipo, el tipo se recalcula como al unir.
            tipo = row["tipo"]
            if any(parse_extremo(x)[0] == "q" for x in (row["a"], row["b"], a, b)):
                con_conector = any(
                    p[0] == "q" and json.loads(r["datos"] or "{}").get("conectores") for p, r in ((pa, ra), (pb, rb))
                )
                tipo = "conector" if con_conector else "fusion"
            v = self.next_version()
            self.conn().execute(
                "UPDATE fusiones SET a = ?, b = ?, tipo = ?, modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                (a, b, tipo, t, usuario, v, fusion_id),
            )
            self.log_change(row["red_id"], usuario, "editar", "fusiones", fusion_id,
                            {"elemento": row["elemento_id"], "a": a, "b": b, "tipo": tipo,
                             "antes": {"a": row["a"], "b": row["b"], "tipo": row["tipo"]}})
            out = {"fusiones": [self.fusion_json(self.get_fusion(fusion_id))], "version": v}
            self.commit()
        except Exception:
            self.rollback()
            raise
        return out


# ------------------------------------------------------------------ validación

def text_field(data: dict, key: str, limit: int, required=False):
    if key not in data:
        if required:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"Falta {key}.")
        return None
    value = data[key]
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{key} tiene que ser texto.")
    value = check_text(value, key).strip()
    if len(value) > limit:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{key} es demasiado largo (máximo {limit} caracteres).")
    return value


def choice_field(data: dict, key: str, choices, required=False):
    value = text_field(data, key, 40, required)
    if value is None:
        return None
    if value not in choices:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{key} inválido. Opciones: {', '.join(choices)}.")
    return value


MAX_ENTERO = 2 ** 53  # lo que cabe sin pérdida en SQLite y en JavaScript


ENTERO = re.compile(r"-?[0-9]{1,19}")


def int_value(value, name: str):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{name} tiene que ser un número entero.")
    if isinstance(value, str) and not ENTERO.fullmatch(value):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{name} tiene que ser un número entero.")
    number = int(value)
    if abs(number) > MAX_ENTERO:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{name} está fuera de rango.")
    return number


def int_field(data: dict, key: str, low: int, high: int, required=False):
    if key not in data:
        if required:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"Falta {key}.")
        return None
    value = int_value(data[key], key)
    if not low <= value <= high:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{key} tiene que estar entre {low} y {high}.")
    return value


def check_text(value: str, name: str) -> str:
    """Rechaza texto que no se puede guardar como UTF-8 (por ejemplo, surrogates sueltos)."""
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{name} tiene caracteres inválidos.")
    return value


def constante_invalida(nombre):
    raise ValueError(f"constante no admitida: {nombre}")


def coord_pair(lon, lat):
    if isinstance(lon, bool) or isinstance(lat, bool):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Coordenadas inválidas.")
    try:
        lon, lat = float(lon), float(lat)
    except (TypeError, ValueError, OverflowError):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Coordenadas inválidas.")
    if not (math.isfinite(lon) and math.isfinite(lat)) or not (-180 <= lon <= 180 and -85 <= lat <= 85):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Coordenadas fuera de rango.")
    return [round(lon, 7), round(lat, 7)]


def datos_field(data: dict):
    if "datos" not in data:
        return None
    value = data["datos"]
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "datos tiene que ser un objeto.")
    clean = {}
    for key, item in value.items():
        if not isinstance(key, str) or not key or len(key) > 40:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Nombre de campo inválido en datos.")
        check_text(key, "datos")
        if isinstance(item, str):
            item = check_text(item, key).strip()[:500]
        elif isinstance(item, int) and not isinstance(item, bool) and abs(item) > MAX_ENTERO:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"El campo {key} está fuera de rango.")
        elif isinstance(item, float) and not math.isfinite(item):
            raise ApiError(HTTPStatus.BAD_REQUEST, f"El campo {key} no es un número válido.")
        elif item is None or isinstance(item, (bool, int, float)):
            pass
        else:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"El campo {key} de datos tiene un valor no admitido.")
        if item not in ("", None):
            clean[key] = item
    if len(json.dumps(clean, ensure_ascii=False)) > MAX_DATOS:
        raise ApiError(HTTPStatus.BAD_REQUEST, "datos es demasiado grande.")
    return clean


def bloque_carta(key, campo: str) -> str:
    if not isinstance(key, str) or not BLOQUE_CARTA.fullmatch(key):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"carta.{campo} inválido.")
    return key


def carta_field(data: dict):
    """Disposición de la carta de empalme, la misma para todos. Es solo
    presentación y llega como cambio parcial (lo que no viene queda como estaba):
      lados  {c12:a: i|d}       de qué lado se dibuja cada cable (reemplaza los anteriores)
      orden  [c12:a, q3, ...]   de arriba abajo, en las columnas (reemplaza)
      pos    {c12:a: [x, y]}    dónde quedó cada bloque en el modo libre: se suma a lo que
                                había; null en un bloque lo quita, pos: null las quita todas
    Columnas o libre lo elige cada dispositivo y no se guarda acá.
    carta: null vuelve a la disposición automática. Las claves desconocidas se descartan."""
    if "carta" not in data:
        return None
    value = data["carta"]
    if value is None:
        return {"_vaciar": True}
    if not isinstance(value, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "carta tiene que ser un objeto.")
    patch = {}
    if "lados" in value:
        lados = {} if value["lados"] is None else value["lados"]
        if not isinstance(lados, dict) or len(lados) > MAX_LADOS:
            raise ApiError(HTTPStatus.BAD_REQUEST, "carta.lados inválido.")
        clean = {}
        for key, side in lados.items():
            if not isinstance(key, str) or not LADO_CARTA.fullmatch(key) or side not in ("i", "d"):
                raise ApiError(HTTPStatus.BAD_REQUEST, "carta.lados inválido.")
            clean[key] = side
        patch["lados"] = clean
    if "orden" in value:
        orden = [] if value["orden"] is None else value["orden"]
        if not isinstance(orden, list) or len(orden) > MAX_BLOQUES:
            raise ApiError(HTTPStatus.BAD_REQUEST, "carta.orden inválido.")
        clean = []
        for key in orden:
            if bloque_carta(key, "orden") in clean:
                raise ApiError(HTTPStatus.BAD_REQUEST, "carta.orden inválido.")
            clean.append(key)
        patch["orden"] = clean
    if "pos" in value:
        pos = value["pos"]
        if pos is None:
            patch["pos"] = None
        else:
            if not isinstance(pos, dict) or len(pos) > MAX_BLOQUES:
                raise ApiError(HTTPStatus.BAD_REQUEST, "carta.pos inválido.")
            clean = {}
            for key, xy in pos.items():
                bloque_carta(key, "pos")
                if xy is None:
                    clean[key] = None
                    continue
                if (not isinstance(xy, list) or len(xy) != 2
                        or any(isinstance(n, bool) or not isinstance(n, (int, float))
                               or (isinstance(n, float) and not math.isfinite(n)) or abs(n) > MAX_POS for n in xy)):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "carta.pos inválido.")
                clean[key] = [int(round(xy[0])), int(round(xy[1]))]
            patch["pos"] = clean
    return patch


def merge_carta(guardada: dict, patch: dict) -> dict:
    """Aplica un cambio parcial de carta_field sobre la disposición guardada."""
    if patch.get("_vaciar"):
        return {}
    out = dict(guardada) if isinstance(guardada, dict) else {}
    for key in ("lados", "orden"):
        if key in patch:
            if patch[key]:
                out[key] = patch[key]
            else:
                out.pop(key, None)
    if "pos" in patch:
        pos = {} if patch["pos"] is None else dict(out.get("pos") or {})
        for key, xy in (patch["pos"] or {}).items():
            if xy is None:
                pos.pop(key, None)
            else:
                pos[key] = xy
        if pos:
            out["pos"] = pos
        else:
            out.pop("pos", None)
    if len(out.get("pos") or {}) > MAX_BLOQUES or len(json.dumps(out)) > MAX_CARTA:
        raise ApiError(HTTPStatus.BAD_REQUEST, "La disposición de la carta es demasiado grande.")
    return out


def version_field(value):
    """Versión que el usuario tenía a la vista (opcional)."""
    if value is None or value == "":
        return None
    return int_value(value, "version")


def element_fields(data: dict, creating: bool) -> dict:
    out = {}
    tipo = choice_field(data, "tipo", TIPOS_ELEMENTO, required=creating)
    if tipo is not None:
        out["tipo"] = tipo
    for key, limit in (("nombre", MAX_NOMBRE), ("notas", MAX_NOTAS)):
        value = text_field(data, key, limit)
        if value is not None:
            out[key] = value
    estado = choice_field(data, "estado", ESTADOS)
    if estado is not None:
        out["estado"] = estado
    if creating or "lon" in data or "lat" in data:
        if "lon" not in data or "lat" not in data:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Faltan lon y lat.")
        out["lon"], out["lat"] = coord_pair(data["lon"], data["lat"])
    datos = datos_field(data)
    if datos is not None:
        out["datos"] = datos
    carta = carta_field(data)
    if carta is not None:
        out["carta"] = carta
    return out


def cable_fields(data: dict, creating: bool) -> dict:
    out = {}
    for key, choices in (("tipo", TIPOS_CABLE), ("estado", ESTADOS), ("tendido", TENDIDOS), ("colores", COLORES)):
        value = choice_field(data, key, choices)
        if value is not None:
            out[key] = value
    for key, limit in (("nombre", MAX_NOMBRE), ("notas", MAX_NOTAS)):
        value = text_field(data, key, limit)
        if value is not None:
            out[key] = value
    fibras = int_field(data, "fibras", 1, MAX_FIBRAS)
    if fibras is not None:
        out["fibras"] = fibras
    por_tubo = int_field(data, "por_tubo", 0, MAX_POR_TUBO)
    if por_tubo is not None:
        out["por_tubo"] = por_tubo
    if creating or "coords" in data or "nodos" in data:
        coords = data.get("coords")
        if not isinstance(coords, list) or len(coords) < 2:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Un cable necesita al menos dos puntos.")
        if len(coords) > MAX_VERTICES:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"Demasiados puntos (máximo {MAX_VERTICES}).")
        clean = []
        for pair in coords:
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Coordenadas inválidas.")
            clean.append(coord_pair(pair[0], pair[1]))
        nodos = data.get("nodos")
        if nodos is None:
            nodos = [None] * len(clean)
        if not isinstance(nodos, list) or len(nodos) != len(clean):
            raise ApiError(HTTPStatus.BAD_REQUEST, "nodos tiene que tener un valor por punto.")
        nodos = list(nodos)
        for node in nodos:
            if node is not None and not (isinstance(node, int) and not isinstance(node, bool) and 0 < node <= MAX_ENTERO):
                raise ApiError(HTTPStatus.BAD_REQUEST, "nodos inválidos.")
        # Dos puntos seguidos sobre el mismo elemento son el mismo punto.
        i = 1
        while i < len(nodos):
            if nodos[i] is not None and nodos[i] == nodos[i - 1]:
                del nodos[i], clean[i]
            else:
                i += 1
        if len(clean) < 2:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Los dos puntos del cable están sobre el mismo elemento.")
        if all(clean[i] == clean[0] for i in range(len(clean))):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Los puntos del cable están todos en el mismo lugar.")
        out["coords"], out["nodos"] = clean, nodos
    datos = datos_field(data)
    if datos is not None:
        out["datos"] = datos
    return out


def equipo_fields(data: dict, creating: bool) -> dict:
    out = {}
    tipo = choice_field(data, "tipo", TIPOS_EQUIPO, required=creating)
    if tipo is not None:
        out["tipo"] = tipo
    for key, limit in (("nombre", MAX_NOMBRE), ("notas", MAX_NOTAS)):
        value = text_field(data, key, limit)
        if value is not None:
            out[key] = value
    for key, high in (("entradas", 2), ("salidas", MAX_PUERTOS_OLT)):
        value = int_field(data, key, 0, high)
        if value is not None:
            out[key] = value
    datos = datos_field(data)
    if datos is not None:
        out["datos"] = datos
    return out


def pares_field(data: dict) -> list:
    pares = data.get("pares")
    if not isinstance(pares, list) or not pares:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Faltan los pares a unir.")
    if len(pares) > MAX_PARES:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"Demasiadas uniones juntas (máximo {MAX_PARES}).")
    out = []
    for par in pares:
        if not isinstance(par, dict) or not isinstance(par.get("a"), str) or not isinstance(par.get("b"), str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Cada par es {a, b}.")
        out.append((par["a"], par["b"]))
    return out


def ids_field(data: dict) -> list:
    ids = data.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > MAX_PARES:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Faltan las uniones a quitar.")
    out = []
    for value in ids:
        number = int_value(value, "ids")
        if number <= 0:
            raise ApiError(HTTPStatus.BAD_REQUEST, "ids inválidos.")
        if number not in out:
            out.append(number)
    return out


# --------------------------------------------------------------- integraciones
#
# Wispro (el sistema de gestión del ISP) y el panel de la OLT (SmartOLT libre):
# traza solo los lee. Cada red puede tener los suyos en integraciones.json, junto
# a la base y con permisos 600, así el token de Wispro nunca pasa por el visor:
#   {"redes": {"1": {"wispro": {"token": "…"},
#                    "panel": {"url": "http://10.10.0.230:8080", "olts": [1]}}}}
# Lo leído se guarda un rato en memoria (VIVE_*) para no pedirlo en cada ficha.

WISPRO_URL = "https://www.cloud.wispro.co/api/v1"
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
SN_EN_TEXTO = re.compile(r"(?<![0-9A-Za-z])([0-9A-Fa-f]{8}[-\s]?[0-9A-Fa-f]{8}|[A-Za-z]{4}[-\s]?[0-9A-Fa-f]{8})(?![0-9A-Za-z])")
VIVE_WISPRO = 300  # s: NAPs, contratos y clientes de Wispro
VIVE_PANEL = 60  # s: ONTs del panel (el panel las lee cada 2 minutos)
VIVE_HISTORIA = 300  # s: serie y eventos de una ONT
VIVE_EN_VIVO = 60  # s: una medición en vivo por Wispro no se repite antes
MUESTRA_EN_VIVO = 900  # s: y se sigue mostrando hasta este tiempo
VIVE_FALLA = 30  # s: después de una falla no se reintenta enseguida (no hace esperar a cada ficha)
REFRESCO_MINIMO = 15  # s: "Actualizar" no vuelve a pedir lo que se trajo hace menos
ESPERA_WISPRO, TOTAL_WISPRO = 20, 30  # s: por cada lectura del socket y por pedido completo
ESPERA_PANEL, TOTAL_PANEL = 8, 12
PLAZO_DATOS = 35  # s que un pedido del visor espera a Wispro y al panel (nginx corta a los 60)
PLAZO_HISTORIA = 8  # s para la historia de las ONTs de una caja; lo que no llega, se ve después
PLAZO_MEDIR = 40  # s para las mediciones en vivo de una caja (contando lo que tardó leer Wispro)
VIVE_ACCION = 1800  # s: medir, agregar o vincular usan la última lectura de Wispro si es de hace menos
MAX_CONTRATOS_NAP = 128
MAX_EN_VIVO = 64
MAX_PAGINAS = 100
CERCA_M = 300  # un cliente de traza y un contrato con el mismo nombre, a lo sumo a esta distancia
NUMERO_CERCA_M = 2000  # un cliente con el número de un contrato o de abonado, a lo sumo a esta distancia
CANDIDATAS_M = 1500  # NAPs de Wispro que se ofrecen para vincular una caja, hasta esta distancia
LEJOS_CAJA_M = 2000  # un contrato ubicado más lejos que esto de su caja no se agrega al mapa
DUDA_CAJA_M = 150  # la NAP de Wispro más cercana a una caja del mapa sin vincular, a menos de esto, podría ser esa caja
MAX_IMPORTACION = 5000  # elementos que se agregan de una vez al traer una red de Wispro
ESTADOS_WISPRO = {"enabled": "activo", "alerted": "activo", "degraded": "activo", "disabled": "instalado"}

# Las lecturas de Wispro y del panel corren en estos hilos: un pedido del visor las
# espera un plazo y, si no llegan, responde con lo que tiene; la lectura sigue y
# queda para el próximo pedido.
_HILOS = ThreadPoolExecutor(max_workers=24, thread_name_prefix="integracion")
# Las colecciones de Wispro van en hilos aparte: una lectura que corre en _HILOS no
# espera nunca a tareas de su mismo grupo, así no se traba con mucha carga.
_HILOS_WISPRO = ThreadPoolExecutor(max_workers=8, thread_name_prefix="integracion-wispro")


class IntegracionError(Exception):
    """Una falla al leer Wispro o el panel, con un mensaje para el usuario."""

    def __init__(self, message: str, codigo: int = None):
        super().__init__(message)
        self.codigo = codigo


def normalizado(texto) -> str:
    """Minúsculas y sin tildes."""
    s = unicodedata.normalize("NFD", str(texto or ""))
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower().strip()


def palabras(texto) -> set:
    """Las palabras de un nombre que sirven para compararlo (sin 'de', 'la'…)."""
    return {p for p in re.split(r"[^a-z0-9]+", normalizado(texto)) if len(p) >= 3}


def parecido(a: set, b: set) -> float:
    """Qué parte del nombre más corto está en el otro (de 0 a 1)."""
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def mismo_nombre(a: set, b: set) -> bool:
    return parecido(a, b) >= 0.75 and len(a & b) >= min(2, len(a), len(b))


def clave_caja(nombre) -> str:
    """'NAP-031', 'nap 31' y 'Nap31' son la misma caja ('NAP31'). Entre dos números
    el separador cuenta: 'NAP 1-2' ('NAP1-2') no es 'NAP12'."""
    partes = re.findall(r"[A-Z]+|\d+", normalizado(nombre).upper())
    out = ""
    for i, p in enumerate(partes):
        if p.isdigit():
            if i and partes[i - 1].isdigit():
                out += "-"
            p = str(int(p))
        out += p
    return out


def sn_canonico(valor):
    """El número de serie de una ONT en una sola forma, 'HWTC90BCF28A'. Acepta el
    hexadecimal de 16 cifras ('4857544390BCF28A', como lo da la OLT) y el de
    fabricante y 8 cifras ('HWTC-90BCF28A')."""
    if valor in (None, ""):
        return None
    t = re.sub(r"[^0-9A-Za-z]", "", str(valor)).upper()
    if re.fullmatch(r"[0-9A-F]{16}", t):
        try:
            fabricante = bytes.fromhex(t[:8]).decode("ascii")
        except (ValueError, UnicodeDecodeError):
            fabricante = ""
        return fabricante + t[8:] if re.fullmatch(r"[A-Z0-9]{4}", fabricante) else t
    return t if 8 <= len(t) <= 32 else None


def sns_en_texto(texto) -> list:
    """Los números de serie que aparecen en un texto libre ('HG8145V5 · 48575443…')."""
    return [s for s in (sn_canonico(m) for m in SN_EN_TEXTO.findall(str(texto or ""))) if s]


def numero_de_descripcion(texto):
    """'#394 Gómez Ana' -> 394: el número de contrato con que Wispro describe la ONT."""
    m = re.match(r"\s*#\s*(\d{1,9})(?!\d)", str(texto or ""))
    return int(m.group(1)) if m else None


def numero(valor):
    """'-27.69' -> -27.69; '-', '' o cualquier otra cosa -> None."""
    if valor is None or isinstance(valor, bool):
        return None
    try:
        n = float(str(valor).strip().replace(",", "."))
    except ValueError:
        return None
    return n if math.isfinite(n) else None


def interfaz_pon(valor):
    """'0/19/3' o 'GPON 0/19/3:5' -> '0/19/3' (marco, placa y puerto)."""
    partes = re.findall(r"\d+", str(valor or ""))
    return "/".join(str(int(p)) for p in partes[:3]) if len(partes) >= 3 else None


def ubicacion(lat, lon):
    """[lon, lat] si son coordenadas que sirven (no 0,0), si no None."""
    la, lo = numero(lat), numero(lon)
    if la is None or lo is None or (abs(la) < 1e-6 and abs(lo) < 1e-6) or not (-85 <= la <= 85 and -180 <= lo <= 180):
        return None
    return [round(lo, 7), round(la, 7)]


def texto_corto(valor, limite: int):
    s = str(valor or "").strip()
    return s[:limite] or None


def hace_texto(iso) -> str:
    """'hace 7 min', 'hace 3 h', 'hace 8 días'."""
    horas = horas_desde(iso)
    if horas is None:
        return "antes"
    if horas < 1 / 60:
        return "recién"
    if horas < 1:
        return f"hace {round(horas * 60)} min"
    if horas < 48:
        return f"hace {round(horas)} h"
    return f"hace {round(horas / 24)} días"


def motivo_de(err) -> str:
    """Una falla de red, en palabras."""
    r = getattr(err, "reason", None) or err
    if isinstance(r, (TimeoutError, socket.timeout)) or "timed out" in str(r):
        return "no respondió a tiempo"
    if isinstance(r, ConnectionRefusedError):
        return "rechazó la conexión (¿está andando?)"
    if isinstance(r, socket.gaierror):
        return "no se encontró su dirección"
    if isinstance(r, ssl.SSLError):
        return "hubo un problema con su certificado HTTPS"
    if isinstance(r, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, http.client.HTTPException)):
        return "cortó la conexión"
    if isinstance(r, OSError) and r.errno in (errno.EHOSTUNREACH, errno.ENETUNREACH):
        return "no se llega a su dirección"
    return "no responde"


class _SinRedireccion(urllib.request.HTTPRedirectHandler):
    """Una redirección no se sigue: podría llevar el token de Wispro a otro lado."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_ABRIDOR = urllib.request.build_opener(urllib.request.ProxyHandler({}), _SinRedireccion)


def pedir_json(url: str, cabeceras: dict = None, espera: float = 10, total: float = 20,
               limite: int = 48 * 1024 * 1024):
    """GET de un JSON, con `espera` segundos por lectura y `total` para todo el
    pedido. Devuelve (estado HTTP, datos) o lanza IntegracionError."""
    fin = time.monotonic() + total
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "traza-ftth",
                                               **(cabeceras or {})})
    try:
        with _ABRIDOR.open(req, timeout=espera) as res:
            estado = res.status
            partes, tam = [], 0
            while True:
                if time.monotonic() > fin:
                    raise IntegracionError("no respondió a tiempo")
                parte = res.read1(65536)
                if not parte:
                    break
                tam += len(parte)
                if tam > limite:
                    raise IntegracionError("respondió algo demasiado grande")
                partes.append(parte)
            cuerpo = b"".join(partes)
    except urllib.error.HTTPError as err:
        estado = err.code
        try:
            cuerpo = err.read(256 * 1024)
        except (OSError, http.client.HTTPException):
            cuerpo = b""
    except IntegracionError:
        raise
    except (OSError, http.client.HTTPException, ValueError) as err:
        raise IntegracionError(motivo_de(err)) from None
    try:
        return estado, json.loads(cuerpo.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, RecursionError):
        if estado != 200:
            raise IntegracionError(f"respondió {estado}", estado) from None
        raise IntegracionError("respondió algo que no es JSON") from None


class Wispro:
    """La API pública de Wispro. Responde 200 aun con errores (el estado real va
    en el cuerpo) y entrega las colecciones de a páginas."""

    def __init__(self, token: str, url: str = WISPRO_URL):
        self.token = token
        self.url = (url or WISPRO_URL).rstrip("/")

    def get(self, ruta: str, **params) -> dict:
        consulta = urlencode(params)
        estado, data = pedir_json(f"{self.url}{ruta}{'?' + consulta if consulta else ''}",
                                  {"Authorization": self.token}, ESPERA_WISPRO, TOTAL_WISPRO)
        real = data.get("status") if isinstance(data, dict) and isinstance(data.get("status"), int) else estado
        if 401 in (estado, real):
            raise IntegracionError("no aceptó el token", 401)
        if estado != 200 or real != 200:
            detalle = ""
            if isinstance(data, dict):
                errores = data.get("errors")
                if isinstance(errores, dict):
                    detalle = "; ".join(str(x) for v in errores.values() for x in (v if isinstance(v, list) else [v]))
                detalle = detalle or str(data.get("message") or "")
            raise IntegracionError(f"respondió {real}" + (f": {detalle[:200]}" if detalle else ""), real)
        if not isinstance(data, dict):
            raise IntegracionError("respondió algo inesperado")
        return data

    def todo(self, ruta: str) -> list:
        """Una colección completa, página por página."""
        out = []
        for pagina in range(1, MAX_PAGINAS + 1):
            data = self.get(ruta, page=pagina, per_page=1000)
            items = data.get("data")
            if not isinstance(items, list):
                raise IntegracionError("respondió algo inesperado")
            out.extend(x for x in items if isinstance(x, dict))
            total = ((data.get("meta") or {}).get("pagination") or {}).get("total_pages")
            if not items or not isinstance(total, int) or pagina >= total:
                return out
        log.warning("Wispro %s: más de %d páginas, se leyeron las primeras", ruta, MAX_PAGINAS)
        return out

    def total(self, ruta: str):
        """Cuántos hay en una colección, sin traerla."""
        data = self.get(ruta, page=1, per_page=1)
        return ((data.get("meta") or {}).get("pagination") or {}).get("total_records")

    def estado_ont(self, contrato_id: str) -> dict:
        """La ONT de un contrato, que Wispro lee en ese momento de la OLT."""
        try:
            data = self.get(f"/contracts/{contrato_id}/status_ont")
        except IntegracionError as err:
            if err.codigo in (400, 404, 412, 422):
                texto = str(err)
                if "blanco" in texto or "not found" in texto.lower():
                    return {"error": "sin ONT vinculada en Wispro"}
                return {"error": texto}
            raise
        anidado = data.get("data") if isinstance(data.get("data"), dict) else {}
        for cand in (data.get("olt"), anidado.get("olt"), anidado, data):
            if isinstance(cand, dict) and ("rx_power" in cand or "serial_number" in cand):
                return medida_wispro(cand)
        return {"error": "Wispro no devolvió la potencia"}


class Panel:
    """El panel de la OLT (SmartOLT libre): las ONTs con su última lectura, la
    historia de cada una y los umbrales."""

    def __init__(self, url: str, olts=None):
        self.url = url.rstrip("/")
        lista = olts if isinstance(olts, list) else [olts] if olts is not None else []
        self.olts_red = [int(x) for x in lista
                         if (isinstance(x, int) and not isinstance(x, bool)) or (isinstance(x, str) and x.isdigit())]

    def get(self, ruta: str, **params):
        consulta = urlencode(params)
        estado, data = pedir_json(f"{self.url}{ruta}{'?' + consulta if consulta else ''}", None, ESPERA_PANEL, TOTAL_PANEL)
        if estado != 200:
            raise IntegracionError(f"respondió {estado}", estado)
        return data

    def olts(self) -> list:
        data = self.get("/api/olts")
        return [o for o in (data if isinstance(data, list) else []) if isinstance(o, dict)]

    def onts(self, olt_id: int) -> list:
        """Todas las ONTs de una OLT. Se pide de a 500 hasta que no vengan nuevas
        (sirve aunque el panel entregue menos por página o ignore el desplazamiento)."""
        out, vistas, desde = [], set(), 0
        for _ in range(MAX_PAGINAS):
            data = self.get(f"/api/olts/{olt_id}/onts", limit=500, offset=desde)
            items = data if isinstance(data, list) else (data.get("items") if isinstance(data, dict) else None)
            if not isinstance(items, list):
                raise IntegracionError("respondió algo inesperado")
            nuevas = [x for x in items if isinstance(x, dict) and (x.get("id"), x.get("sn")) not in vistas]
            if not nuevas:
                break
            vistas.update((x.get("id"), x.get("sn")) for x in nuevas)
            out.extend(nuevas)
            desde += len(items)
        return out

    def historia(self, ont_id: int) -> dict:
        serie = self.get(f"/api/onts/{ont_id}/series", hours=168, buckets=42)
        eventos = self.get(f"/api/onts/{ont_id}/events", limit=20)
        return {"tendencia": tendencia_panel(serie), "eventos": eventos_panel(eventos)}

    def umbrales(self):
        data = self.get("/api/thresholds")
        return data if isinstance(data, dict) else None


def medida_panel(ont: dict, olt_nombre=None) -> dict:
    """Lo que el panel sabe de una ONT, como lo usa traza."""
    slot, port = ont.get("slot"), ont.get("port")
    marco = ont.get("frame") if isinstance(ont.get("frame"), int) else 0
    ok = all(isinstance(x, int) and not isinstance(x, bool) for x in (slot, port))
    return {
        "fuente": "panel",
        "panel_id": ont.get("id") if isinstance(ont.get("id"), int) else None,
        "olt": texto_corto(olt_nombre, 80),
        "sn": sn_canonico(ont.get("sn")),
        "interfaz": f"{marco}/{slot}/{port}" if ok else None,
        "ont_id": ont.get("ont_id") if isinstance(ont.get("ont_id"), int) else None,
        "estado": texto_corto(ont.get("run_state"), 30),
        "rx": numero(ont.get("rx_power_dbm")),
        "tx": numero(ont.get("tx_power_dbm")),
        "rx_estado": texto_corto(ont.get("rx_status"), 30),
        "cuando": texto_corto(ont.get("last_seen"), 40),
        "ultima_caida": texto_corto(ont.get("last_down_time"), 40),
        "causa": texto_corto(ont.get("last_down_cause"), 60),
        "tecnologia": texto_corto(ont.get("technology"), 40),
    }


def medida_wispro(o: dict) -> dict:
    return {
        "fuente": "wispro",
        "sn": sn_canonico(o.get("serial_number")),
        "interfaz": interfaz_pon(o.get("ont_interface")),
        "rx": numero(o.get("rx_power")),
        "tx": numero(o.get("tx_power")),
        "temperatura": numero(o.get("temperature")),
        "rx_estado": texto_corto(o.get("status_rx_power"), 30),
        "cuando": now_iso(),
    }


def tendencia_panel(serie):
    t = serie.get("trend") if isinstance(serie, dict) else None
    if not isinstance(t, dict):
        return None
    muestras = t.get("samples") if isinstance(t.get("samples"), int) else None
    return {"muestras": muestras, "rx_min": numero(t.get("rx_min")), "rx_max": numero(t.get("rx_max")),
            "rx_prom": numero(t.get("rx_avg")), "db_semana": numero(t.get("rx_db_per_week")),
            "desde": texto_corto(t.get("first_at"), 40), "hasta": texto_corto(t.get("last_at"), 40)}


def eventos_panel(eventos) -> list:
    out = []
    for e in eventos if isinstance(eventos, list) else []:
        if not isinstance(e, dict):
            continue
        det = e.get("details") if isinstance(e.get("details"), dict) else {}
        out.append({"cuando": texto_corto(e.get("occurred_at"), 40), "tipo": texto_corto(e.get("event_type"), 40),
                    "causa": texto_corto(det.get("cause") or det.get("reason") or det.get("down_cause"), 60)})
    return out[:20]


class DatosWispro:
    """Una lectura completa de Wispro (NAPs, contratos, clientes y OLTs), con índices."""

    def __init__(self, naps: list, contratos: list, clientes: list, olts: list):
        self.cuando = now_iso()
        self.naps = naps
        self.naps_por_id = {n.get("id"): n for n in naps}
        self.contratos = contratos
        self.por_nap, self.por_id, self.por_sn, self.por_numero, self.por_cliente = {}, {}, {}, {}, {}
        self.clientes = {c.get("id"): c for c in clientes}
        for c in contratos:
            self.por_nap.setdefault(c.get("nap_id"), []).append(c)
            self.por_id[c.get("id")] = c
            sn = sn_canonico(c.get("ont_serial_number"))
            if sn:
                self.por_sn.setdefault(sn, []).append(c)
            if c.get("public_id") is not None:
                self.por_numero.setdefault(str(c["public_id"]), []).append(c)
            numero_cliente = (self.clientes.get(c.get("client_id")) or {}).get("public_id")
            if numero_cliente is not None:
                self.por_cliente.setdefault(str(numero_cliente), []).append(c)
        self.olts = {o.get("id"): o for o in olts}

    def nap(self, n: dict, distancia=None, por=None) -> dict:
        olt = self.olts.get(n.get("olt_id")) or {}
        fbp = n.get("fbp")
        return {
            "id": n.get("id"),
            "nombre": texto_corto(n.get("name"), 80) or "",
            "capacidad": n.get("capacity") if isinstance(n.get("capacity"), int) else None,
            "contratos": len(self.por_nap.get(n.get("id"), [])),
            "fbp": interfaz_pon(fbp) or texto_corto(fbp, 20),
            "olt": texto_corto(olt.get("name"), 80),
            "ubicacion": ubicacion(n.get("latitude"), n.get("longitude")),
            "distancia_m": round(distancia) if distancia is not None else None,
            "por": por,
        }

    def contrato(self, c: dict) -> dict:
        cli = self.clientes.get(c.get("client_id")) or {}
        calle = " ".join(str(x).strip() for x in (c.get("address_street"), c.get("address_number")) if x not in (None, ""))
        if not calle:
            calle = " ".join(str(x).strip() for x in (cli.get("street"), cli.get("number")) if x not in (None, ""))
        return {
            "id": c.get("id"),
            "numero": c.get("public_id") if isinstance(c.get("public_id"), int) else None,
            "estado": texto_corto(c.get("state"), 20),
            "cliente": texto_corto(cli.get("name"), 120) or "",
            "cliente_numero": cli.get("public_id") if isinstance(cli.get("public_id"), int) else None,
            "direccion": texto_corto(calle or cli.get("address"), 200),
            "ubicacion": ubicacion(c.get("latitude"), c.get("longitude")) or ubicacion(cli.get("latitude"), cli.get("longitude")),
            "sn": sn_canonico(c.get("ont_serial_number")),
            "interfaz": interfaz_pon(c.get("interface_gpon")),
            "nap": c.get("nap_id"),
        }


class DatosPanel:
    """Una lectura de las ONTs del panel, con índices por número de serie y por
    el número de contrato de su descripción."""

    def __init__(self, olts: list, onts_por_olt: dict, umbrales):
        self.cuando = now_iso()
        nombres = {o.get("id"): o.get("name") for o in olts}
        self.olts = [texto_corto(nombres.get(i), 80) or f"OLT {i}" for i in onts_por_olt]
        self.umbrales = umbrales
        por_sn, self.por_numero = {}, {}
        leidas = []
        for olt_id, onts in onts_por_olt.items():
            for ont in onts:
                m = medida_panel(ont, nombres.get(olt_id))
                if m["sn"]:
                    por_sn.setdefault(m["sn"], []).append(m)
                n = numero_de_descripcion(ont.get("description"))
                if n is not None:
                    self.por_numero.setdefault(n, []).append(m)
                if m["cuando"]:
                    leidas.append(m["cuando"])
        # Un número de serie repetido (un registro viejo que quedó al mover la ONT de
        # puerto): vale el que está en línea o, si no, el visto último.
        self.por_sn = {sn: max(lista, key=lambda m: (m["estado"] == "online", m["cuando"] or ""))
                       for sn, lista in por_sn.items()}
        self.leido = max(leidas) if leidas else None
        self.total = sum(len(v) for v in onts_por_olt.values())

    def ont(self, sn=None, numero_contrato=None, sns_ajenos=()):
        """La ONT de un contrato: por su número de serie o, si el contrato no lo
        tiene, por el número de contrato con que empieza la descripción (salvo
        que la serie de esa ONT sea la de otro contrato)."""
        if sn:
            m = self.por_sn.get(sn)
            return (m, "sn") if m else (None, None)
        lista = [m for m in self.por_numero.get(numero_contrato, []) if not (m["sn"] and m["sn"] in sns_ajenos)]
        return (lista[0], "numero") if len(lista) == 1 else (None, None)


def lista_uuid(texto) -> list:
    """Contratos de Wispro anotados en datos como texto ("uuid,uuid")."""
    return [u.lower() for u in UUID.findall(str(texto or ""))]


def datos_de(row) -> dict:
    """Los datos de un elemento leído de la base (un objeto, aunque estén mal)."""
    try:
        d = json.loads(row["datos"] or "{}")
    except ValueError:
        return {}
    return d if isinstance(d, dict) else {}


class ClientesTraza:
    """Los clientes de una red de traza, con índices para encontrar el de cada contrato."""

    CELDA = 0.003  # grados, para buscar por cercanía

    def __init__(self, rows):
        self.por_uuid, self.por_sn, self.por_contrato, self.por_abonado = {}, {}, {}, {}
        self.todos, self.grilla = [], {}
        for r in rows:
            d = datos_de(r)
            # "no": contratos que alguien dijo que no son de este cliente.
            ref = {"id": r["id"], "nombre": r["nombre"], "lonlat": [r["lon"], r["lat"]], "palabras": palabras(r["nombre"]),
                   "no": set(lista_uuid(d.get("wispro_no")))}
            u = d.get("wispro_contrato")
            if isinstance(u, str) and UUID.fullmatch(u):
                self.por_uuid.setdefault(u.lower(), []).append(ref)
            for sn in set(sns_en_texto(d.get("ont"))):
                self.por_sn.setdefault(sn, []).append(ref)
            for campo, indice in (("contrato", self.por_contrato), ("abonado", self.por_abonado)):
                v = str(d.get(campo) or "").strip().lstrip("#").strip()
                if v:
                    indice.setdefault(v, []).append(ref)
            self.todos.append(ref)
            self.grilla.setdefault(self._celda(r["lon"], r["lat"]), []).append(ref)

    def _celda(self, lon, lat):
        return (math.floor(lat / self.CELDA), math.floor(lon / self.CELDA))

    def cerca(self, lonlat, radio: float) -> list:
        lon, lat = lonlat
        nlat = math.ceil(radio / (111000 * self.CELDA))
        nlon = math.ceil(radio / (111000 * max(0.1, math.cos(math.radians(lat))) * self.CELDA))
        fila, col = self._celda(lon, lat)
        out = []
        for i in range(fila - nlat, fila + nlat + 1):
            for j in range(col - nlon, col + nlon + 1):
                out.extend(r for r in self.grilla.get((i, j), []) if haversine_m(r["lonlat"], lonlat) <= radio)
        return out


class Cruce:
    """Qué cliente de traza corresponde a cada contrato de Wispro, en toda la red.
    Los criterios van en orden: vinculado a mano, la ONT, el número de contrato,
    el de abonado (si ese cliente de Wispro tiene un solo contrato) y el nombre
    cerca. Un criterio asigna solo si de los dos lados hay una única coincidencia.
    Varios clientes de traza con el mismo vínculo, ONT o contrato (aunque se los
    haya encontrado por criterios distintos) quedan como repetidos; los que
    coinciden en algo sin poder asignarse (un número lejos, un nombre que tienen
    dos), como dudosos: hay que confirmarlos, y mientras tanto ese contrato no se
    agrega al mapa. Un cliente nunca se cruza con un contrato del que alguien dijo
    "no es este" (wispro_no). La vista de la caja, la del cliente, agregar al mapa
    y el comando probar usan este mismo cruce."""

    FUERTES = ("vinculado", "ont", "contrato")
    CRITERIOS = ("vinculado", "ont", "contrato", "abonado", "nombre")

    def __init__(self, dw: DatosWispro, rows):
        self.dw = dw
        self.traza = ClientesTraza(rows)
        self.items = {c.get("id"): dw.contrato(c) for c in dw.contratos if c.get("id")}
        self.lugar_nap = {n.get("id"): ubicacion(n.get("latitude"), n.get("longitude")) for n in dw.naps}
        self.de_contrato = {}  # id de contrato -> {"id", "nombre", "por"} | {"repetidos": […], "por"} | {"dudosos": […]}
        self.de_cliente = {}  # id de cliente de traza -> (id de contrato, por)
        self.dudas_de_cliente = {}  # id de cliente de traza -> [ids de contrato]
        usados = set()
        for criterio in self.CRITERIOS:
            candidatos = {}
            for cid, item in self.items.items():
                if cid in self.de_contrato:
                    continue
                refs = list({r["id"]: r for r in self._candidatos(criterio, item) if r["id"] not in usados}.values())
                if refs:
                    candidatos[cid] = refs
            pedidos = {}
            for cid, refs in candidatos.items():
                for r in refs:
                    pedidos.setdefault(r["id"], []).append(cid)
            for cid, refs in candidatos.items():
                if any(len(pedidos[r["id"]]) > 1 for r in refs):
                    continue  # un cliente de traza que pide más de un contrato: ambiguo
                if len(refs) == 1:
                    self.de_contrato[cid] = {"id": refs[0]["id"], "nombre": refs[0]["nombre"], "por": criterio}
                elif criterio in self.FUERTES:
                    self.de_contrato[cid] = {"repetidos": [{"id": r["id"], "nombre": r["nombre"]} for r in refs],
                                             "por": criterio}
                else:
                    continue
                for r in refs:
                    self.de_cliente[r["id"]] = (cid, criterio)
                    usados.add(r["id"])
        # Un cliente con el vínculo, la ONT o el número de un contrato que ya tiene el
        # suyo (encontrado por otro criterio) es el mismo cliente dibujado dos veces.
        for cid, asignado in list(self.de_contrato.items()):
            extra = {}
            for criterio in self.FUERTES:
                for r in self._candidatos(criterio, self.items[cid]):
                    if r["id"] not in usados and r["id"] not in extra:
                        extra[r["id"]] = (r, criterio)
            if not extra:
                continue
            if "repetidos" in asignado:
                ya, por = asignado["repetidos"], asignado["por"]
            else:
                ya, por = [{"id": asignado["id"], "nombre": asignado["nombre"]}], next(iter(extra.values()))[1]
            self.de_contrato[cid] = {"repetidos": ya + [{"id": r["id"], "nombre": r["nombre"]} for r, _ in extra.values()],
                                     "por": por}
            for rid, (_, criterio) in extra.items():
                self.de_cliente[rid] = (cid, criterio)
                usados.add(rid)
        # Lo que no se pudo asignar pero tiene un cliente de traza con su vínculo, su
        # ONT, su número (aunque esté lejos) o su nombre cerca: queda para confirmar.
        for cid, item in self.items.items():
            if cid in self.de_contrato:
                continue
            refs = {}
            for criterio in self.CRITERIOS:
                for r in self._candidatos(criterio, item, todos=True):
                    if r["id"] not in usados and r["id"] not in refs:
                        duda = {"id": r["id"], "nombre": r["nombre"], "por": criterio}
                        d = self._distancia(r, item)
                        if d is not None and d > NUMERO_CERCA_M:
                            duda["lejos_m"] = round(d)
                        refs[r["id"]] = duda
            if refs:
                self.de_contrato[cid] = {"dudosos": list(refs.values())}
                for rid in refs:
                    self.dudas_de_cliente.setdefault(rid, []).append(cid)

    def _lugares(self, item) -> list:
        """Dónde debería estar el cliente de un contrato: su ubicación en Wispro y la
        de su NAP (si la del contrato está mal cargada, la de la NAP sirve igual)."""
        out = [item["ubicacion"]] if item["ubicacion"] else []
        u = self.lugar_nap.get(item["nap"])
        if u:
            out.append(u)
        return out

    def _distancia(self, ref, item):
        lugares = self._lugares(item)
        return min(haversine_m(ref["lonlat"], u) for u in lugares) if lugares else None

    def _plausible(self, ref, item, pedir_nombre: bool) -> bool:
        """Un número coincide de casualidad seguido (los de contrato y los de cliente
        van por separado): vale si el cliente está cerca del contrato o de su NAP, o,
        sin ubicaciones, si se parecen los nombres."""
        d = self._distancia(ref, item)
        if d is not None:
            return d <= NUMERO_CERCA_M
        return not pedir_nombre or bool(palabras(item["cliente"]) & ref["palabras"])

    def _candidatos(self, criterio: str, item: dict, todos: bool = False) -> list:
        """Los clientes de traza que coinciden con un contrato por un criterio. Con
        todos=True (para los dudosos), también los números lejos y los clientes de
        Wispro con varios contratos. Un «No es» descarta lo dudoso (el abonado, el
        nombre, un número lejos), no lo que coincide de verdad: la ONT o el número de
        contrato cerca, que el técnico anotó (si no es, se corrige el dato)."""
        refs = self._coinciden(criterio, item, todos)
        if criterio in ("vinculado", "ont"):
            return refs
        no = str(item["id"] or "").lower()
        if criterio == "contrato":
            return [r for r in refs if no not in r["no"] or self._plausible(r, item, False)]
        return [r for r in refs if no not in r["no"]]

    def coincidencias(self, cliente_id) -> list:
        """Los contratos con los que coincide algún dato de un cliente del mapa (aunque
        sean de otro cliente o se hayan descartado), con el primer criterio que coincide:
        [(id de contrato, criterio)]. Para explicar en su ficha por qué no se le asignó."""
        out = []
        for cid, item in self.items.items():
            for criterio in self.CRITERIOS:
                if any(r["id"] == cliente_id for r in self._coinciden(criterio, item, True)):
                    out.append((cid, criterio))
                    break
        return out

    def _coinciden(self, criterio: str, item: dict, todos: bool) -> list:
        t = self.traza
        if criterio == "vinculado":
            return t.por_uuid.get(str(item["id"] or "").lower(), [])
        if criterio == "ont":
            return t.por_sn.get(item["sn"], []) if item["sn"] else []
        if criterio == "contrato":
            refs = t.por_contrato.get(str(item["numero"]), []) if item["numero"] is not None else []
            return refs if todos else [r for r in refs if self._plausible(r, item, False)]
        if criterio == "abonado":
            n = item["cliente_numero"]
            if n is None or (not todos and len(self.dw.por_cliente.get(str(n), [])) != 1):
                return []
            refs = t.por_abonado.get(str(n), [])
            return refs if todos else [r for r in refs if self._plausible(r, item, True)]
        if not item["cliente"]:
            return []
        pal = palabras(item["cliente"])
        out = {}
        for lugar in self._lugares(item):
            for r in t.cerca(lugar, CERCA_M):
                if r["id"] not in out and mismo_nombre(pal, r["palabras"]):
                    out[r["id"]] = r
        return list(out.values())

    def en_traza(self, cid: str):
        """Para la ficha: {"id", "nombre", "por"}, {"repetidos": …}, {"dudosos": …} o None."""
        return self.de_contrato.get(cid)


def caja_de_wispro(dw: DatosWispro, row):
    """La NAP de Wispro de una caja de traza: la que se vinculó a mano o, si no
    hay, la única con el mismo nombre. Devuelve (nap, por)."""
    guardada = datos_de(row).get("wispro_nap")
    if isinstance(guardada, str) and guardada in dw.naps_por_id:
        return dw.naps_por_id[guardada], "vinculada"
    clave = clave_caja(row["nombre"])
    iguales = [n for n in dw.naps if clave and clave_caja(n.get("name")) == clave]
    if len(iguales) == 1:
        return iguales[0], "nombre"
    return None, ("perdida" if guardada else None)


def candidatas(dw: DatosWispro, row) -> list:
    """NAPs de Wispro que pueden ser esta caja: las más cercanas y las de nombre parecido."""
    aca = [row["lon"], row["lat"]]
    clave = clave_caja(row["nombre"])
    elegidas = {}
    cerca = []
    for n in dw.naps:
        u = ubicacion(n.get("latitude"), n.get("longitude"))
        d = haversine_m(aca, u) if u else None
        if d is not None and d <= CANDIDATAS_M:
            cerca.append((d, n))
    for d, n in sorted(cerca, key=lambda x: x[0])[:6]:
        elegidas[n.get("id")] = (d, n)
    if len(clave) >= 2:
        for n in dw.naps:
            k = clave_caja(n.get("name"))
            if k and (clave in k or k in clave) and n.get("id") not in elegidas and len(elegidas) < 9:
                u = ubicacion(n.get("latitude"), n.get("longitude"))
                elegidas[n.get("id")] = (haversine_m(aca, u) if u else None, n)
    orden = sorted(elegidas.values(), key=lambda x: (x[0] is None, x[0] or 0))
    return [dw.nap(n, d) for d, n in orden]


class Integraciones:
    """Lo que traza lee de Wispro y del panel de la OLT, red por red, con caché."""

    def __init__(self, ruta: str):
        self.ruta = ruta
        self._candado = threading.Lock()
        self._config = {}
        self._firma = None
        self._cache = {}  # clave -> (cuando, valor)
        self._fallas = {}  # clave -> (cuando, IntegracionError)
        self._candados = {}

    # --- configuración (se relee sola cuando cambia el archivo)
    def config(self) -> dict:
        try:
            st = os.stat(self.ruta)
            firma = (st.st_mtime_ns, st.st_size, st.st_ino)
        except OSError:
            firma = None
        with self._candado:
            if firma != self._firma:
                data = {}
                if firma is not None:
                    try:
                        with open(self.ruta, encoding="utf-8") as fh:
                            data = json.load(fh)
                    except (OSError, ValueError) as err:
                        log.warning("no se pudo leer %s: %s", self.ruta, err)
                self._config = data if isinstance(data, dict) else {}
                self._firma = firma
                # Lo leído con la configuración anterior no sirve (las claves de la caché
                # llevan la firma, así que tampoco lo que esté leyéndose ahora).
                self._cache.clear()
                self._fallas.clear()
                self._candados.clear()
            return self._config

    def de_red(self, red_id: int) -> dict:
        redes = self.config().get("redes")
        cfg = redes.get(str(red_id)) if isinstance(redes, dict) else None
        return cfg if isinstance(cfg, dict) else {}

    def wispro(self, red_id: int):
        c = self.de_red(red_id).get("wispro")
        if isinstance(c, dict) and isinstance(c.get("token"), str) and c["token"].strip():
            return Wispro(c["token"].strip(), c.get("url") or WISPRO_URL)
        return None

    def panel(self, red_id: int):
        c = self.de_red(red_id).get("panel")
        if isinstance(c, dict) and isinstance(c.get("url"), str) and c["url"].startswith(("http://", "https://")):
            return Panel(c["url"], c.get("olts"))
        return None

    def estado(self, red_id: int) -> dict:
        return {"wispro": self.wispro(red_id) is not None, "panel": self.panel(red_id) is not None}

    # --- caché
    def _guardado(self, clave, vive: float, traer, refrescar=False, respaldo=False, plazo: float = PLAZO_DATOS):
        """Lo que devuelve traer(), guardado `vive` segundos. Si dos pedidos quieren
        lo mismo a la vez, el segundo espera al primero (hasta `plazo`). Una falla
        se recuerda VIVE_FALLA segundos para no hacer esperar a cada ficha. Con
        respaldo=True devuelve (valor, falla): si traerlo falla y hay un valor
        anterior bueno, ese, con la falla para avisarla."""
        pedido = time.monotonic()
        clave = (self._firma,) + clave
        with self._candado:
            candado = self._candados.setdefault(clave, threading.Lock())

        def fallar(err):
            with self._candado:
                hit = self._cache.get(clave)
            if respaldo and hit:
                return hit[1], err
            raise IntegracionError(str(err), err.codigo)

        if not candado.acquire(timeout=plazo):
            return fallar(IntegracionError("está tardando en responder"))
        try:
            with self._candado:
                hit, falla = self._cache.get(clave), self._fallas.get(clave)
            ahora = time.monotonic()
            if hit and (hit[0] >= pedido or (ahora - hit[0] < vive and not (refrescar and ahora - hit[0] >= REFRESCO_MINIMO))):
                return (hit[1], None) if respaldo else hit[1]
            if falla and (falla[0] >= pedido or (ahora - falla[0] < VIVE_FALLA and not (refrescar and ahora - falla[0] >= 3))):
                return fallar(falla[1])
            try:
                valor = traer()
            except IntegracionError as err:
                with self._candado:
                    self._fallas[clave] = (time.monotonic(), err)
                return fallar(err)
            with self._candado:
                self._cache[clave] = (time.monotonic(), valor)
                self._fallas.pop(clave, None)
            return (valor, None) if respaldo else valor
        finally:
            candado.release()

    def _ultimo(self, clave):
        """Lo último bueno que se leyó (sin esperar a una lectura en curso)."""
        hit = self._ultimo_con_edad(clave)
        return hit[0] if hit else None

    def _ultimo_con_edad(self, clave):
        """(lo último bueno que se leyó, hace cuántos segundos) o None."""
        with self._candado:
            hit = self._cache.get((self._firma,) + clave)
        return (hit[1], time.monotonic() - hit[0]) if hit else None

    def datos_wispro(self, red_id: int, refrescar=False):
        """(DatosWispro, falla): la falla, si se devuelve una lectura anterior."""
        w = self.wispro(red_id)
        if w is None:
            return None

        def traer():
            pedidos = {k: _HILOS_WISPRO.submit(w.todo, f"/{k}") for k in ("naps", "contracts", "clients", "olts")}
            naps, contratos, clientes = (pedidos[k].result() for k in ("naps", "contracts", "clients"))
            try:
                olts = pedidos["olts"].result()
            except IntegracionError:
                olts = []
            return DatosWispro(naps, contratos, clientes, olts)

        return self._guardado(("wispro", red_id), VIVE_WISPRO, traer, refrescar, respaldo=True)

    def datos_panel(self, red_id: int, refrescar=False):
        """(DatosPanel, falla), como datos_wispro."""
        p = self.panel(red_id)
        if p is None:
            return None

        def traer():
            olts = p.olts()
            hay = {o.get("id") for o in olts}
            ids = p.olts_red
            if not ids:
                # Sin decir cuáles, solo si hay una sola: el panel puede tener OLTs de otras empresas.
                if len(olts) != 1:
                    raise IntegracionError("tiene varias OLT y no se indicó cuál es de esta red "
                                           "(sudo /srv/ftth/bin/integraciones panel RED URL --olt N)")
                ids = [olts[0].get("id")]
            for i in ids:
                if i not in hay:
                    raise IntegracionError(f"no tiene la OLT {i}")
            onts = {i: p.onts(i) for i in ids}
            try:
                umbrales = p.umbrales()
            except IntegracionError:
                umbrales = None
            return DatosPanel(olts, onts, umbrales)

        return self._guardado(("panel", red_id), VIVE_PANEL, traer, refrescar, respaldo=True)

    def historia(self, red_id: int, panel_id: int, refrescar=False):
        p = self.panel(red_id)
        if p is None:
            raise IntegracionError("ya no está configurado")
        return self._guardado(("historia", red_id, panel_id), VIVE_HISTORIA, lambda: p.historia(panel_id), refrescar)

    def en_vivo(self, red_id: int, contrato_id: str, w: Wispro):
        return self._guardado(("vivo", red_id, contrato_id), VIVE_EN_VIVO, lambda: w.estado_ont(contrato_id))

    def en_vivo_guardado(self, red_id: int, contrato_id):
        with self._candado:
            hit = self._cache.get((self._firma, "vivo", red_id, contrato_id))
        if hit and isinstance(hit[1], dict) and "error" not in hit[1] and time.monotonic() - hit[0] < MUESTRA_EN_VIVO:
            return hit[1]
        return None

    def _leer(self, red_id: int, refrescar: bool, out: dict):
        """Wispro y el panel a la vez, esperando a lo sumo PLAZO_DATOS. Lo que falla
        o tarda queda anotado en out["errores"]; si hay una lectura anterior, se usa."""
        tareas = {}
        if self.wispro(red_id) is not None:
            tareas["wispro"] = _HILOS.submit(self.datos_wispro, red_id, refrescar)
        if self.panel(red_id) is not None:
            tareas["panel"] = _HILOS.submit(self.datos_panel, red_id, refrescar)
        wait(list(tareas.values()), timeout=PLAZO_DATOS)
        res = {}
        for nombre, etiqueta in (("wispro", "Wispro"), ("panel", "Panel de la OLT")):
            tarea = tareas.get(nombre)
            res[nombre] = None
            if tarea is None:
                continue
            if not tarea.done():
                anterior = self._ultimo((nombre, red_id))
                out["errores"].append(f"{etiqueta}: está tardando en responder"
                                      + (f"; se muestra lo leído {hace_texto(anterior.cuando)}." if anterior else
                                         "; probá «Actualizar» en un momento."))
                res[nombre] = anterior
                continue
            try:
                valor, falla = tarea.result()
            except IntegracionError as err:
                out["errores"].append(f"{etiqueta}: {err}.")
                continue
            if falla:
                out["errores"].append(f"{etiqueta}: {falla}; se muestra lo leído {hace_texto(valor.cuando)}.")
            res[nombre] = valor
        return res["wispro"], res["panel"]

    def _panel_json(self, dp):
        return {"leido": dp.leido, "onts": dp.total, "olts": dp.olts, "umbrales": dp.umbrales}

    def _historias(self, red_id: int, items: list, refrescar: bool, out: dict):
        """La serie y los eventos de cada ONT (para la estabilidad), a la vez y con
        plazo: lo que no llega se ve en la próxima lectura."""
        tareas = {}
        for item in items:
            pid = (item.get("medida") or {}).get("panel_id")
            if pid is not None and pid not in tareas:
                tareas[pid] = _HILOS.submit(self.historia, red_id, pid, refrescar)
        wait(list(tareas.values()), timeout=PLAZO_HISTORIA)
        faltan = 0
        for item in items:
            pid = (item.get("medida") or {}).get("panel_id")
            if pid is None:
                continue
            tarea = tareas[pid]
            item["historia"] = None
            if tarea.done() and tarea.exception() is None:
                item["historia"] = tarea.result()
            else:
                faltan += 1
        if faltan:
            out["errores"].append(f"Panel de la OLT: falta la historia de {faltan} ONT{'s' if faltan > 1 else ''} "
                                  "(tardó o falló); se completa en la próxima lectura.")

    # --- lo que pide el visor
    def nap(self, store, row, refrescar=False, con_candidatas=False) -> dict:
        red_id = row["red_id"]
        out = {"configurada": self.estado(red_id), "errores": []}
        dw, dp = self._leer(red_id, refrescar, out)
        if dp is not None:
            out["panel"] = self._panel_json(dp)
        if dw is None:
            return out
        out["wispro"] = {"leido": dw.cuando}
        nap, por = caja_de_wispro(dw, row)
        if nap is None:
            out["perdida"] = por == "perdida"
            out["candidatas"] = candidatas(dw, row)
            return out
        caja = [row["lon"], row["lat"]]
        u = ubicacion(nap.get("latitude"), nap.get("longitude"))
        out["nap"] = dw.nap(nap, haversine_m(caja, u) if u else None, por)
        if con_candidatas:  # para cambiar el vínculo
            out["candidatas"] = candidatas(dw, row)
        cruce = Cruce(dw, store.clientes_red(red_id))
        items = []
        for c in dw.por_nap.get(nap.get("id"), [])[:MAX_CONTRATOS_NAP]:
            item = dict(cruce.items[c.get("id")])
            item["traza"] = cruce.en_traza(item["id"])
            if item["ubicacion"]:
                d = haversine_m(caja, item["ubicacion"])
                item["lejos_m"] = round(d) if d > LEJOS_CAJA_M else None
            item["medida"] = dp.ont(item["sn"], None if item["sn"] else item["numero"], dw.por_sn)[0] if dp else None
            item["vivo"] = self.en_vivo_guardado(red_id, item["id"])
            items.append(item)
        if dp is not None:
            self._historias(red_id, items, refrescar, out)
        out["contratos"] = items
        return out

    def cliente(self, store, row, refrescar=False) -> dict:
        red_id = row["red_id"]
        out = {"configurada": self.estado(red_id), "errores": []}
        dw, dp = self._leer(red_id, refrescar, out)
        datos = datos_de(row)
        item = None
        if dw is not None:
            out["wispro"] = {"leido": dw.cuando}
            cruce = Cruce(dw, store.clientes_red(red_id))
            hit = cruce.de_cliente.get(row["id"])
            if hit:
                cid, por = hit
                item = dict(cruce.items[cid])
                item["por"] = por
                item["nap_nombre"] = texto_corto((dw.naps_por_id.get(item["nap"]) or {}).get("name"), 80)
                item["vivo"] = self.en_vivo_guardado(red_id, cid)
                otros = [r for r in (cruce.en_traza(cid) or {}).get("repetidos", []) if r["id"] != row["id"]]
                if otros:
                    item["repetidos"] = otros
            dudas = []
            for cid in cruce.dudas_de_cliente.get(row["id"], []):
                d = dict(cruce.items[cid])
                duda = next((x for x in cruce.en_traza(cid)["dudosos"] if x["id"] == row["id"]), {})
                d["por"], d["lejos_m"] = duda.get("por"), duda.get("lejos_m")
                d["nap_nombre"] = texto_corto((dw.naps_por_id.get(d["nap"]) or {}).get("name"), 80)
                dudas.append(d)
            if dudas:
                out["posibles"] = dudas[:10]

            def resumen(cid):
                c = cruce.items[cid]
                return {"id": cid, "numero": c["numero"], "cliente": c["cliente"],
                        "nap_nombre": texto_corto((dw.naps_por_id.get(c["nap"]) or {}).get("name"), 80)}

            # Los contratos que se marcaron «No es» (se pueden volver a considerar)...
            no = lista_uuid(datos.get("wispro_no"))
            original = {str(k).lower(): k for k in cruce.items}
            descartados = [resumen(original[u]) if u in original else {"id": u} for u in no]
            if descartados:
                out["descartados"] = descartados
            # ...y, si no se le asignó ninguno, con cuáles coincide algún dato aunque sean de
            # otro cliente del mapa (puede ser el mismo cliente dibujado dos veces).
            if not hit and not dudas:
                ocupados = []
                for cid, criterio in cruce.coincidencias(row["id"]):
                    asignado = cruce.en_traza(cid) or {}
                    en_mapa = asignado.get("repetidos") or ([asignado] if asignado.get("id") else [])
                    if str(cid).lower() in no or not en_mapa:
                        continue
                    ocupados.append({**resumen(cid), "por": criterio,
                                     "en_mapa": [{"id": r["id"], "nombre": r["nombre"]} for r in en_mapa]})
                if ocupados:
                    out["ocupados"] = ocupados[:10]
        out["contrato"] = item
        sn = (item or {}).get("sn") or next(iter(sns_en_texto(datos.get("ont"))), None)
        if dp is not None:
            out["panel"] = self._panel_json(dp)
            medida = dp.ont(sn, None if sn else (item or {}).get("numero"), dw.por_sn if dw else ())[0]
            out["medida"] = medida
            if medida and medida.get("panel_id") is not None:
                try:
                    out["historia"] = self.historia(red_id, medida["panel_id"], refrescar)
                except IntegracionError as err:
                    out["errores"].append(f"Panel de la OLT: {err}.")
        return out

    def _wispro_o_error(self, red_id: int):
        """Wispro para una acción (medir, agregar, vincular): la última lectura si es de
        hace menos de VIVE_ACCION (es lo que el usuario está viendo); si no, se lee con
        plazo, y si tarda o falla se usa la anterior que haya."""
        w = self.wispro(red_id)
        if w is None:
            raise ApiError(HTTPStatus.CONFLICT, "Esta red no está conectada con Wispro.")
        anterior = self._ultimo_con_edad(("wispro", red_id))
        if anterior and anterior[1] < VIVE_ACCION:
            return w, anterior[0]
        tarea = _HILOS.submit(self.datos_wispro, red_id)
        try:
            dw, _ = tarea.result(timeout=PLAZO_DATOS)
        except FuturesTimeout:
            if anterior:
                return w, anterior[0]
            raise ApiError(HTTPStatus.GATEWAY_TIMEOUT, "Wispro está tardando en responder: probá de nuevo en un momento.")
        except IntegracionError as err:
            if anterior and err.codigo != 401:
                return w, anterior[0]
            raise ApiError(HTTPStatus.BAD_GATEWAY, f"No se pudo leer Wispro: {err}.")
        return w, dw

    def _medir(self, red_id: int, w: Wispro, ids: list, plazo: float = PLAZO_MEDIR) -> dict:
        tareas = {cid: _HILOS.submit(self.en_vivo, red_id, cid, w) for cid in ids}
        wait(list(tareas.values()), timeout=max(5, plazo))
        medidas = {}
        for cid, tarea in tareas.items():
            if not tarea.done():
                medidas[cid] = {"error": "Wispro no respondió a tiempo"}
            elif isinstance(tarea.exception(), IntegracionError):
                err = tarea.exception()
                if err.codigo == 401:
                    raise ApiError(HTTPStatus.BAD_GATEWAY, "Wispro no aceptó el token: hay que revisarlo en el servidor.")
                medidas[cid] = {"error": str(err)}
            else:
                medidas[cid] = tarea.result()
        return {"medidas": medidas}

    def medir_nap(self, row) -> dict:
        red_id = row["red_id"]
        inicio = time.monotonic()
        w, dw = self._wispro_o_error(red_id)
        nap, _ = caja_de_wispro(dw, row)
        if nap is None:
            raise ApiError(HTTPStatus.CONFLICT, "Primero vinculá esta caja con su NAP de Wispro.")
        ids = [c.get("id") for c in dw.por_nap.get(nap.get("id"), []) if c.get("ont_serial_number")][:MAX_EN_VIVO]
        return self._medir(red_id, w, ids, PLAZO_MEDIR - (time.monotonic() - inicio))

    def medir_cliente(self, store, row) -> dict:
        red_id = row["red_id"]
        inicio = time.monotonic()
        w, dw = self._wispro_o_error(red_id)
        hit = Cruce(dw, store.clientes_red(red_id)).de_cliente.get(row["id"])
        if hit is None:
            raise ApiError(HTTPStatus.CONFLICT, "No se encontró el contrato de este cliente en Wispro.")
        return self._medir(red_id, w, [hit[0]], PLAZO_MEDIR - (time.monotonic() - inicio))

    def importar(self, store, row, ids: list, usuario: str) -> dict:
        """Agrega al mapa los clientes de una caja que están en Wispro y no en traza.
        El cruce se hace dentro de la misma transacción que los agrega: dos pedidos
        a la vez no duplican nada."""
        red_id = row["red_id"]
        _, dw = self._wispro_o_error(red_id)
        nap, _ = caja_de_wispro(dw, row)
        if nap is None:
            raise ApiError(HTTPStatus.CONFLICT, "Primero vinculá esta caja con su NAP de Wispro.")
        de_la_caja = {c.get("id"): c for c in dw.por_nap.get(nap.get("id"), [])}
        caja = [row["lon"], row["lat"]]

        def preparar(rows):
            cruce = Cruce(dw, rows)
            nuevos, omitidos = [], []
            for cid in ids:
                if cid not in de_la_caja:
                    omitidos.append({"contrato": cid, "motivo": "no es de esta caja en Wispro"})
                    continue
                item = cruce.items[cid]
                en_traza = cruce.en_traza(cid)
                # Un número que coincide lejos (a más de 2 km) no frena: es poco probable que sea el mismo.
                if en_traza and any(not d.get("lejos_m") for d in en_traza.get("dudosos", [])):
                    omitidos.append({"contrato": cid, "motivo": "hay un cliente en el mapa que podría ser este: confirmalo desde la caja"})
                    continue
                if en_traza and en_traza.get("dudosos"):
                    en_traza = None
                if en_traza:
                    omitidos.append({"contrato": cid, "motivo": "ya está en el mapa"})
                    continue
                if not item["ubicacion"]:
                    omitidos.append({"contrato": cid, "motivo": "no tiene ubicación en Wispro"})
                    continue
                d = haversine_m(caja, item["ubicacion"])
                if d > LEJOS_CAJA_M:
                    omitidos.append({"contrato": cid, "motivo": f"su ubicación en Wispro está a {d / 1000:.1f} km de la caja".replace(".", ",")})
                    continue
                nuevos.append(cliente_de_contrato(item, nap.get("name")))
            return nuevos, omitidos

        return store.importar_clientes(red_id, preparar, usuario, origen="wispro")

    def vincular(self, store, row, contrato_id: str, usuario: str) -> dict:
        """Confirma que un cliente de traza es el de un contrato de Wispro."""
        _, dw = self._wispro_o_error(row["red_id"])
        c = dw.por_id.get(contrato_id)
        if c is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "Ese contrato ya no está en Wispro.")
        return store.vincular_cliente(row["id"], dw.contrato(c), usuario, {str(k).lower() for k in dw.por_id})

    def desvincular(self, store, row, contrato_id: str, usuario: str, deshacer: bool = False) -> dict:
        """El cliente no es el de ese contrato (o, con deshacer, sí puede serlo). Anda
        aunque Wispro no responda (entonces no se sabe qué datos había completado el
        vínculo, y quedan)."""
        if deshacer:
            return store.desvincular_cliente(row["id"], contrato_id, None, usuario, deshacer=True)
        try:
            _, dw = self._wispro_o_error(row["red_id"])
        except ApiError:
            dw = None
        c = dw.por_id.get(contrato_id) if dw is not None else None
        return store.desvincular_cliente(row["id"], contrato_id, dw.contrato(c) if c else None, usuario)

    # --- traer toda la red de Wispro (cajas y clientes)
    def _wispro_reciente(self, red_id: int):
        """Wispro leído recién (para mostrar qué se va a agregar), con plazo; si tarda o
        falla, la lectura anterior y una nota. Devuelve (DatosWispro, nota)."""
        if self.wispro(red_id) is None:
            raise ApiError(HTTPStatus.CONFLICT, "Esta red no está conectada con Wispro.")
        tarea = _HILOS.submit(self.datos_wispro, red_id, True)
        try:
            dw, falla = tarea.result(timeout=PLAZO_DATOS)
        except FuturesTimeout:
            anterior = self._ultimo(("wispro", red_id))
            if anterior is None:
                raise ApiError(HTTPStatus.GATEWAY_TIMEOUT, "Wispro está tardando en responder: probá de nuevo en un momento.")
            return anterior, f"Wispro está tardando en responder: se usa lo leído {hace_texto(anterior.cuando)}."
        except IntegracionError as err:
            raise ApiError(HTTPStatus.BAD_GATEWAY, f"No se pudo leer Wispro: {err}.")
        return dw, (f"Wispro: {falla}; se usa lo leído {hace_texto(dw.cuando)}." if falla else None)

    def misma_cuenta(self, red_id: int) -> list:
        """Las otras redes conectadas con la misma cuenta de Wispro (el mismo token)."""
        w = self.wispro(red_id)
        redes = self.config().get("redes")
        if w is None or not isinstance(redes, dict):
            return []
        out = []
        for clave in redes:
            if not clave.isdigit() or int(clave) == red_id:
                continue
            otra = self.wispro(int(clave))
            if otra is not None and otra.token == w.token and otra.url == w.url:
                out.append(int(clave))
        return out

    def previa_importacion(self, store, red_id: int, olts=None, fresco: bool = True) -> dict:
        """Qué cajas y clientes de Wispro se agregarían al mapa, sin cambiar nada. Con
        fresco=False (al elegir otras OLTs) alcanza con la última lectura de Wispro."""
        if fresco:
            dw, nota = self._wispro_reciente(red_id)
        else:
            (_, dw), nota = self._wispro_o_error(red_id), None
        plan = plan_importacion(dw, store.naps_red(red_id), store.clientes_red(red_id), olts=olts)
        out = {k: v for k, v in plan.items() if not k.startswith("_")}
        out["wispro"] = {"leido": dw.cuando}
        out["errores"] = [nota] if nota else []
        out["ultima"] = store.ultima_importacion(red_id)
        otras = [store.network_info(r) for r in self.misma_cuenta(red_id)]
        out["misma_cuenta"] = [r["nombre"] for r in otras if r]
        return out

    def importar_red(self, store, red_id: int, cajas: bool, clientes: bool, igual, olts, usuario: str) -> dict:
        """Agrega al mapa las cajas y los clientes de Wispro que faltan, de una vez (una
        versión: se deshace con deshacer_importacion), de las OLTs de `olts` (None: las
        que se eligen solas). Las cajas que podrían estar ya en el mapa (dudosas) van
        solo si están en `igual`."""
        _, dw = self._wispro_o_error(red_id)

        def preparar():
            plan = plan_importacion(dw, store.naps_red(red_id), store.clientes_red(red_id), igual, olts)
            nuevas = (plan["_cajas"] if cajas else []) + plan["_igual"]
            nuevos = nuevas + (plan["_clientes"] if clientes else [])
            if len(nuevos) > MAX_IMPORTACION:
                raise ApiError(HTTPStatus.BAD_REQUEST, f"Son demasiados elementos para agregar de una vez ({len(nuevos)}).")
            return nuevos, {"agregados": {"cajas": len(nuevas), "clientes": len(nuevos) - len(nuevas)}}

        return store.importar_elementos(red_id, preparar, usuario, origen="wispro", lote=True)

    def quitar_olts(self, store, red_id: int, olts, usuario: str) -> dict:
        """Quita del mapa las cajas y los clientes de estas OLTs de Wispro (por la NAP de cada
        caja y la de cada contrato) que agregó una importación y siguen como quedaron."""
        _, dw = self._wispro_o_error(red_id)
        olts = set(olts)
        naps = {i for i, n in dw.naps_por_id.items() if isinstance(i, str) and i and clave_olt(n) in olts}
        ids = [r["id"] for r in store.naps_red(red_id) if (caja_de_wispro(dw, r)[0] or {}).get("id") in naps]
        cruce = Cruce(dw, store.clientes_red(red_id))
        ids += [cliente_id for cliente_id, (cid, _) in cruce.de_cliente.items()
                if cid in cruce.items and cruce.items[cid]["nap"] in naps]
        return store.quitar_importados(red_id, ids, usuario, "quitar lo de otra OLT")


def cliente_de_contrato(item: dict, nap_nombre) -> dict:
    """Un cliente de traza con lo que dice su contrato de Wispro."""
    nombre = check_text(item["cliente"] or (f"Contrato #{item['numero']}" if item["numero"] is not None else "Cliente"),
                        "nombre")[:MAX_NOMBRE].strip()
    datos = {
        "contrato": str(item["numero"]) if item["numero"] is not None else None,
        "abonado": str(item["cliente_numero"]) if item["cliente_numero"] is not None else None,
        "direccion": item["direccion"],
        "ont": item["sn"],
        "nap_puerto": texto_corto(nap_nombre, 80),
    }
    datos["wispro_llenados"] = ",".join(k for k, v in datos.items() if v not in (None, ""))
    datos["wispro_contrato"] = item["id"]
    datos = datos_field({"datos": datos})
    lon, lat = coord_pair(*item["ubicacion"])
    return {"tipo": "cliente", "nombre": nombre, "estado": ESTADOS_WISPRO.get(item["estado"], "instalado"),
            "lon": lon, "lat": lat, "datos": datos, "notas": ""}


def caja_de_nap(n: dict, nombre: str, u) -> dict:
    """Una caja NAP de traza con lo que dice su NAP de Wispro (queda vinculada)."""
    datos = {"wispro_nap": n.get("id"), "wispro_nap_nombre": nombre}
    capacidad = numero(n.get("capacity"))  # 16 (o "16")
    if capacidad is not None and capacidad.is_integer() and 0 < capacidad <= 1024:
        datos["puertos"] = str(int(capacidad))
        datos["wispro_llenados"] = "puertos"
    lon, lat = coord_pair(*u)
    return {"tipo": "nap", "nombre": check_text(nombre, "nombre")[:MAX_NOMBRE].strip() or "NAP", "estado": "instalado",
            "lon": lon, "lat": lat, "datos": datos_field({"datos": datos}), "notas": ""}


SIN_OLT = "sin-olt"  # las NAPs de Wispro que no tienen OLT, como si fueran una


def clave_olt(n: dict) -> str:
    olt = n.get("olt_id")
    return olt if isinstance(olt, str) and olt else SIN_OLT


def grupos_olt(dw: DatosWispro, naps: list, en_mapa_por_nap: Counter) -> list:
    """Las NAPs de Wispro por OLT: cuántas son, cuántas tienen contratos, cuántas están en el
    mismo lugar que una NAP de otra OLT (gemelas) y cuántas cajas del mapa son de esa OLT."""
    grupos, lugares = {}, {}
    for n in naps:
        k = clave_olt(n)
        g = grupos.setdefault(k, {"id": k, "nombre": texto_corto((dw.olts.get(k) or {}).get("name"), 80)
                                   or ("Sin OLT" if k == SIN_OLT else "OLT sin nombre"),
                                   "cajas": 0, "con_contratos": 0, "contratos": 0, "gemelas": 0, "en_mapa": 0})
        g["cajas"] += 1
        contratos = len(dw.por_nap.get(n["id"], []))
        g["con_contratos"] += 1 if contratos else 0
        g["contratos"] += contratos
        g["en_mapa"] += en_mapa_por_nap.get(n["id"], 0)
        u = ubicacion(n.get("latitude"), n.get("longitude"))
        if u:
            lugares.setdefault((round(u[0], 5), round(u[1], 5)), []).append(k)  # el mismo lugar: a menos de 1 m
    for ks in lugares.values():
        for k in ks:
            if any(o != k for o in ks):
                grupos[k]["gemelas"] += 1
    activa = lambda g: g["con_contratos"] > 0.05 * g["cajas"]
    for g in grupos.values():
        # Reemplazada: casi sin contratos y con la mayoría de sus NAPs en el mismo lugar que las de
        # otra OLT que sí se usa (por ejemplo, las cajas de una OLT vieja cargadas de nuevo en la nueva).
        g["reemplazada"] = (len(grupos) >= 2 and not activa(g) and g["gemelas"] * 2 >= g["cajas"]
                            and any(o is not g and activa(o) for o in grupos.values()))
    return sorted(grupos.values(), key=lambda g: (-g["contratos"], -g["cajas"], g["nombre"]))


def plan_importacion(dw: DatosWispro, naps_rows, clientes_rows, igual=(), olts=None) -> dict:
    """Qué cajas y qué clientes de Wispro faltan en el mapa, listos para agregar
    (_cajas, _clientes), y por qué no se agrega el resto. Usa el mismo cruce que la
    ficha de la caja: no se agrega lo que ya está ni lo que podría estar. Se traen
    las NAPs (y los contratos de las NAPs) de las OLTs de `olts`; sin elegir, de todas
    salvo las que parecen reemplazadas por otra. Una caja del mapa sin vincular puede
    ser una (y solo una) de las NAPs que faltan: la más cercana, a menos de
    DUDA_CAJA_M, queda como dudosa y se agrega solo si su id está en `igual` (_igual)."""
    en_mapa, sueltas, en_mapa_por_nap = set(), [], Counter()
    for r in naps_rows:
        nap, _ = caja_de_wispro(dw, r)
        if nap is not None:
            en_mapa.add(nap.get("id"))
            en_mapa_por_nap[nap.get("id")] += 1
        else:
            sueltas.append(r)  # cajas del mapa sin NAP de Wispro: podrían ser una de las que faltan
    igual = set(igual)
    naps = [n for i, n in dw.naps_por_id.items() if isinstance(i, str) and i]  # una vez cada una
    grupos = grupos_olt(dw, naps, en_mapa_por_nap)
    elegidas = {g["id"] for g in grupos if not g["reemplazada"]} if olts is None else set(olts)
    nombre_olt = {g["id"]: g["nombre"] for g in grupos}
    faltan, cajas_omitidas, cajas_ya = [], [], 0
    for n in naps:
        if clave_olt(n) not in elegidas:
            continue
        nombre = texto_corto(n.get("name"), MAX_NOMBRE) or "NAP"
        if n["id"] in en_mapa:
            cajas_ya += 1
            continue
        u = ubicacion(n.get("latitude"), n.get("longitude"))
        if not u:
            cajas_omitidas.append({"nombre": nombre, "motivo": "no tiene ubicación en Wispro"})
            continue
        faltan.append((n, nombre, u))
    # Cada caja suelta con la NAP más cercana, de a pares (una caja, una NAP), empezando
    # por los pares más cercanos: aunque Wispro tenga muchas NAPs amontonadas cerca, una
    # caja del mapa aparta una sola.
    pares = sorted((haversine_m(u, [r["lon"], r["lat"]]), nombre, n["id"], r["id"], r)
                   for r in sueltas for n, nombre, u in faltan)
    duda_de, con_caja = {}, set()
    for distancia, _, nap_id, caja_id, r in pares:
        if distancia > DUDA_CAJA_M:
            break
        if nap_id in duda_de or caja_id in con_caja:
            continue
        duda_de[nap_id] = (distancia, r)
        con_caja.add(caja_id)
    cajas, con_igual, dudosas = [], [], []
    for n, nombre, u in faltan:
        duda = duda_de.get(n["id"])
        if duda is None:
            cajas.append(caja_de_nap(n, nombre, u))
        elif n["id"] in igual:
            con_igual.append(caja_de_nap(n, nombre, u))
        else:
            distancia, r = duda
            dudosas.append({"id": n["id"], "nombre": nombre, "distancia_m": round(distancia),
                            "caja": {"id": r["id"], "nombre": r["nombre"] or "Caja sin nombre"}})

    cruce = Cruce(dw, clientes_rows)
    clientes, motivos, clientes_ya = [], {}, 0
    clientes_por_olt = Counter()  # clientes del mapa de cada OLT (por la NAP de su contrato)
    for cliente_id, (cid, _) in cruce.de_cliente.items():
        n = dw.naps_por_id.get(cruce.items[cid]["nap"]) if cid in cruce.items else None
        if n is not None:
            clientes_por_olt[clave_olt(n)] += 1

    def omitir(motivo, item):
        numero = f" #{item['numero']}" if item["numero"] is not None else ""
        motivos.setdefault(motivo, []).append(f"{item['cliente'] or 'Sin nombre'}{numero}")

    for cid, item in cruce.items.items():
        n = dw.naps_por_id.get(item["nap"])
        en_traza = cruce.en_traza(cid)
        if n is None:
            omitir("no tiene caja en Wispro", item)
        elif en_traza and not en_traza.get("dudosos"):
            clientes_ya += 1
        elif clave_olt(n) not in elegidas:
            omitir(f"es de una caja de {nombre_olt.get(clave_olt(n), 'otra OLT')}, que no se trae", item)
        elif en_traza and any(not d.get("lejos_m") for d in en_traza.get("dudosos", [])):
            omitir("podría ser un cliente que ya está en el mapa: se confirma desde su caja", item)
        elif not item["ubicacion"]:
            omitir("no tiene ubicación en Wispro", item)
        else:
            u = ubicacion(n.get("latitude"), n.get("longitude"))
            if u and haversine_m(u, item["ubicacion"]) > LEJOS_CAJA_M:
                omitir("su ubicación en Wispro está a más de 2 km de su caja", item)
            else:
                clientes.append(cliente_de_contrato(item, n.get("name")))
    for g in grupos:
        g["elegida"] = g["id"] in elegidas
        g["clientes_en_mapa"] = clientes_por_olt.get(g["id"], 0)
    return {
        "olts": grupos,
        "cajas": {"total": len(naps), "nuevas": len(cajas), "ya": cajas_ya, "omitidas": cajas_omitidas,
                  "dudosas": dudosas},
        "clientes": {"total": len(cruce.items), "nuevos": len(clientes), "ya": clientes_ya,
                     "omitidos": [{"motivo": m, "cantidad": len(e), "ejemplos": e[:20]} for m, e in motivos.items()]},
        "_cajas": cajas,
        "_igual": con_igual,
        "_clientes": clientes,
    }


def olts_field(data: dict, opcional: bool = False):
    """Las OLTs de Wispro elegidas: una lista de ids (None si es opcional y no vino)."""
    value = data.get("olts")
    if value is None and opcional:
        return None
    if not isinstance(value, list) or len(value) > 50 or not all(isinstance(o, str) and 0 < len(o) <= 100 for o in value):
        raise ApiError(HTTPStatus.BAD_REQUEST, "olts tiene que ser una lista de OLTs de Wispro.")
    return value


def contratos_field(data: dict) -> list:
    value = data.get("contratos")
    if not isinstance(value, list) or not value or len(value) > MAX_CONTRATOS_NAP:
        raise ApiError(HTTPStatus.BAD_REQUEST, "contratos tiene que ser una lista de contratos de Wispro.")
    out = []
    for item in value:
        if not isinstance(item, str) or not UUID.fullmatch(item):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Contrato de Wispro inválido.")
        if item not in out:
            out.append(item)
    return out


def contrato_field(data: dict) -> str:
    value = data.get("contrato")
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Contrato de Wispro inválido.")
    return value


# ----------------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "ftth-api/1"
    store: Store = None
    integraciones: Integraciones = None
    secreto: str = ""  # vacío: no se exige (pruebas, desarrollo)

    def log_message(self, fmt, *args):
        log.debug(fmt, *args)

    # --- utilidades
    def user(self) -> str:
        user = (self.headers.get("X-Usuario") or "").strip()
        if not user:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "Sin sesión.")
        return user[:64]

    def same_origin(self) -> bool:
        """El pedido viene de esta misma página (defensa contra formularios de otros sitios)."""
        origin = self.headers.get("Origin") or self.headers.get("Referer")
        if not origin:
            return True
        host = urlsplit(origin).hostname or ""
        expected = (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(":")[0]
        return host.lower() == expected.lower()

    def redes_permitidas(self):
        """Qué redes puede ver el usuario (X-Redes, de ftth-auth vía nginx): None = todas."""
        raw = (self.headers.get("X-Redes") or "").strip()
        if raw in ("", "*"):
            return None  # administra (o nginx todavía no manda la cabecera: como antes de 0.8.0)
        return {int(x) for x in raw.split(",") if x.strip().isdigit()}

    def administra(self) -> bool:
        return self.redes_permitidas() is None

    def permitir(self, red_id: int):
        permitidas = self.redes_permitidas()
        if permitidas is not None and red_id not in permitidas:
            raise ApiError(HTTPStatus.FORBIDDEN, "No tenés acceso a esa red.")

    def objeto_permitido(self, tabla: str, registro_id: int) -> int:
        """Comprueba que el elemento, cable, equipo o unión sea de una red que el usuario
        puede ver (lo que no existe pasa: la operación va a responder 404 por su cuenta)."""
        red_id = self.store.red_de(tabla, registro_id)
        if red_id is not None:
            self.permitir(red_id)
        return registro_id

    def read_json(self) -> dict:
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Se esperaba JSON (Content-Type: application/json).")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Content-Length inválido.")
        if length <= 0:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Falta el cuerpo del pedido.")
        if length > MAX_BODY:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Pedido demasiado grande.")
        try:
            # NaN e Infinity no son JSON: se rechazan como cualquier otro cuerpo inválido.
            data = json.loads(self.rfile.read(length).decode("utf-8"), parse_constant=constante_invalida)
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "El cuerpo no es JSON válido.")
        if not isinstance(data, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Se esperaba un objeto JSON.")
        return data

    def send_json(self, status: int, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8", "replace")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def red_param(self, value, todas: bool = False):
        """El número de red del pedido, comprobado y permitido. Con todas=True (solo las
        lecturas) acepta red=todas para quien administra y devuelve None: todas juntas."""
        if todas and str(value or "").strip().lower() == TODAS:
            if not self.administra():
                raise ApiError(HTTPStatus.FORBIDDEN, "Solo quien administra ve todas las redes juntas.")
            return None
        try:
            red_id = int_value(value, "red")
        except ApiError:
            if str(value or "").strip().lower() == TODAS:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Para cargar elementos elegí una red: en «todas las redes» solo se mira.")
            raise ApiError(HTTPStatus.BAD_REQUEST, "Falta indicar la red.")
        if self.store.network_info(red_id) is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "No existe esa red.")
        self.permitir(red_id)
        return red_id

    @staticmethod
    def element_param(value) -> int:
        try:
            element_id = int_value(value, "elemento")
        except ApiError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Falta indicar el elemento.")
        if element_id <= 0:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Falta indicar el elemento.")
        return element_id

    def element_of_type(self, value, tipo: str):
        row = self.store.get_element(self.element_param(value))
        if row is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "Ese elemento ya no existe: lo borró otro usuario.")
        self.permitir(row["red_id"])
        if row["tipo"] != tipo:
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           "Ese elemento no es una NAP." if tipo == "nap" else "Ese elemento no es un cliente.")
        return row

    @staticmethod
    def route_id(path: str, prefix: str):
        """'/api/elementos/12' -> 12 para prefix '/api/elementos/'; None si no corresponde."""
        if not path.startswith(prefix):
            return None
        rest = path[len(prefix):]
        return int(rest) if rest.isascii() and rest.isdigit() and len(rest) < 12 else None

    def dispatch(self, method: str):
        url = urlsplit(self.path)
        path = url.path
        query = parse_qs(url.query)
        try:
            con_clave = not self.secreto or hmac.compare_digest(
                (self.headers.get("X-Ftth-Secreto") or "").encode(), self.secreto.encode())
            if path == "/api/salud" and method == "GET":
                salud = {"ok": True, "esquema": ESQUEMA}
                if con_clave:
                    salud["codigo"] = CODIGO  # el instalador comprueba que atiende la versión instalada
                self.send_json(HTTPStatus.OK, salud)
                return
            if not con_clave:
                raise ApiError(HTTPStatus.FORBIDDEN, "Pedido no autorizado: la API solo atiende a través de nginx.")
            user = self.user()
            if method != "GET" and not self.same_origin():
                raise ApiError(HTTPStatus.FORBIDDEN, "Origen no permitido.")
            status, payload = self.route(method, path, query, user)
            self.send_json(status, payload)
        except ApiError as err:
            self.send_json(err.status, {"error": err.message, **err.extra})
        except IntegracionError as err:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": f"No se pudo leer el otro sistema: {err}."})
        except sqlite3.OperationalError as err:
            log.exception("base ocupada o con problemas atendiendo %s %s", method, path)
            busy = "locked" in str(err) or "busy" in str(err)
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE if busy else HTTPStatus.INTERNAL_SERVER_ERROR,
                           {"error": "El servidor está ocupado. Probá de nuevo en un momento." if busy
                            else "Error interno del servidor."})
        except Exception:  # noqa: BLE001 - se informa y se sigue atendiendo
            log.exception("error atendiendo %s %s", method, path)
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Error interno del servidor."})
        finally:
            self.store.close()

    def route(self, method, path, query, user):
        store = self.store
        q = lambda key, default="": query.get(key, [default])[0]  # noqa: E731

        if path == "/api/yo" and method == "GET":
            permitidas = self.redes_permitidas()
            return HTTPStatus.OK, {"usuario": user, "administra": permitidas is None,
                                   "redes": None if permitidas is None else sorted(permitidas)}

        if path == "/api/redes":
            if method == "GET":
                permitidas = self.redes_permitidas()
                redes = store.networks()
                if permitidas is not None:
                    redes = [r for r in redes if r["id"] in permitidas]
                return HTTPStatus.OK, {"redes": redes}
            if method == "POST":
                if not self.administra():
                    raise ApiError(HTTPStatus.FORBIDDEN, "Solo quien administra puede crear redes.")
                nombre = text_field(self.read_json(), "nombre", MAX_NOMBRE, required=True)
                if not nombre:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "La red necesita un nombre.")
                return HTTPStatus.CREATED, {"red": store.add_network(nombre, user)}
        red_id = self.route_id(path, "/api/redes/")
        if red_id is not None and method == "PUT":
            if not self.administra():
                raise ApiError(HTTPStatus.FORBIDDEN, "Solo quien administra puede cambiar el nombre de una red.")
            nombre = text_field(self.read_json(), "nombre", MAX_NOMBRE, required=True)
            if not nombre:
                raise ApiError(HTTPStatus.BAD_REQUEST, "La red necesita un nombre.")
            return HTTPStatus.OK, {"red": store.rename_network(red_id, nombre, user)}

        if path == "/api/red" and method == "GET":
            red_id = self.red_param(q("red"), todas=True)
            payload = store.network(red_id)
            payload["red"] = store.network_info(red_id) if red_id is not None else {
                "id": TODAS, "nombre": "Todas las redes", "todas": True, "redes": store.networks()}
            return HTTPStatus.OK, payload

        if path == "/api/cambios" and method == "GET":
            red_id = self.red_param(q("red"), todas=True)
            since = int_value(q("desde", "0") or "0", "desde")
            return HTTPStatus.OK, store.changes(red_id, since)

        if path == "/api/historial" and method == "GET":
            red_id = self.red_param(q("red"))
            try:
                limit = max(1, min(500, int(q("limite", "100"))))
            except ValueError:
                limit = 100
            return HTTPStatus.OK, {"historial": store.history(red_id, limit)}

        if path == "/api/elementos" and method == "POST":
            data = self.read_json()
            red_id = self.red_param(data.get("red"))
            return HTTPStatus.CREATED, store.add_element(red_id, element_fields(data, creating=True), user)
        element_id = self.route_id(path, "/api/elementos/")
        if element_id is not None:
            self.objeto_permitido("elementos", element_id)
            if method == "PUT":
                data = self.read_json()
                return HTTPStatus.OK, store.update_element(
                    element_id, element_fields(data, creating=False), version_field(data.get("version")), user)
            if method == "DELETE":
                return HTTPStatus.OK, store.delete_element(element_id, version_field(q("version")), user)

        if path == "/api/cables" and method == "POST":
            data = self.read_json()
            red_id = self.red_param(data.get("red"))
            return HTTPStatus.CREATED, store.add_cable(red_id, cable_fields(data, creating=True), user)
        cable_id = self.route_id(path, "/api/cables/")
        if cable_id is not None:
            self.objeto_permitido("cables", cable_id)
            if method == "PUT":
                data = self.read_json()
                return HTTPStatus.OK, store.update_cable(
                    cable_id, cable_fields(data, creating=False), version_field(data.get("version")), user)
            if method == "DELETE":
                return HTTPStatus.OK, store.delete_cable(cable_id, version_field(q("version")), user)

        if path == "/api/equipos" and method == "POST":
            data = self.read_json()
            return HTTPStatus.CREATED, store.add_equipo(
                self.objeto_permitido("elementos", self.element_param(data.get("elemento"))),
                equipo_fields(data, creating=True), user)
        equipo_id = self.route_id(path, "/api/equipos/")
        if equipo_id is not None:
            self.objeto_permitido("equipos", equipo_id)
            if method == "PUT":
                data = self.read_json()
                return HTTPStatus.OK, store.update_equipo(
                    equipo_id, equipo_fields(data, creating=False), version_field(data.get("version")), user)
            if method == "DELETE":
                return HTTPStatus.OK, store.delete_equipo(equipo_id, version_field(q("version")), user)

        if path == "/api/fusiones" and method == "POST":
            data = self.read_json()
            tipo = choice_field(data, "tipo", TIPOS_UNION)
            return HTTPStatus.CREATED, store.add_fusiones(
                self.objeto_permitido("elementos", self.element_param(data.get("elemento"))),
                pares_field(data), tipo, user)
        if path == "/api/fusiones/borrar" and method == "POST":
            ids = ids_field(self.read_json())
            for fusion_id in ids:
                self.objeto_permitido("fusiones", fusion_id)
            return HTTPStatus.OK, store.delete_fusiones(ids, None, user)
        fusion_id = self.route_id(path, "/api/fusiones/")
        if fusion_id is not None:
            self.objeto_permitido("fusiones", fusion_id)
        if fusion_id is not None and method == "PUT":
            data = self.read_json()
            cambios = {}
            for key in ("a", "b"):
                if key in data:
                    parse_extremo(data[key])
                    cambios[key] = data[key]
            if not cambios:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Falta la punta nueva (a o b).")
            return HTTPStatus.OK, store.update_fusion(fusion_id, cambios, version_field(data.get("version")), user)
        if fusion_id is not None and method == "DELETE":
            return HTTPStatus.OK, store.delete_fusiones([fusion_id], version_field(q("version")), user)

        if path.startswith("/api/integracion"):
            return self.route_integracion(method, path, q, user)

        raise ApiError(HTTPStatus.NOT_FOUND, "No existe esa ruta.")

    def route_integracion(self, method, path, q, user):
        """Wispro y el panel de la OLT (solo lectura, salvo agregar clientes al mapa)."""
        integ = self.integraciones
        if integ is None:
            raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "Las integraciones no están disponibles en este servidor.")
        if path == "/api/integracion" and method == "GET":
            return HTTPStatus.OK, integ.estado(self.red_param(q("red")))
        if path == "/api/integracion/importacion" and method == "GET":
            olts = q("olts", None)  # sin olts: las que se eligen solas
            olts = None if olts is None else [o for o in olts.split(",") if o]
            if olts is not None and (len(olts) > 50 or not all(len(o) <= 100 for o in olts)):
                raise ApiError(HTTPStatus.BAD_REQUEST, "olts inválidas.")
            return HTTPStatus.OK, integ.previa_importacion(self.store, self.red_param(q("red")), olts, q("leer") != "0")
        if path == "/api/integracion/importacion" and method == "POST":
            data = self.read_json()
            red_id = self.red_param(data.get("red"))
            cajas, clientes, igual = data.get("cajas", True), data.get("clientes", True), data.get("igual", [])
            if not isinstance(cajas, bool) or not isinstance(clientes, bool):
                raise ApiError(HTTPStatus.BAD_REQUEST, "cajas y clientes tienen que ser true o false.")
            if (not isinstance(igual, list) or len(igual) > MAX_IMPORTACION
                    or not all(isinstance(i, str) and 0 < len(i) <= 100 for i in igual)):
                raise ApiError(HTTPStatus.BAD_REQUEST, "igual tiene que ser una lista de NAPs de Wispro.")
            if not cajas and not clientes and not igual:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Elegí cajas, clientes o las dos cosas.")
            return HTTPStatus.OK, integ.importar_red(self.store, red_id, cajas, clientes, igual,
                                                     olts_field(data, opcional=True), user)
        if path == "/api/integracion/importacion/quitar" and method == "POST":
            data = self.read_json()
            red_id = self.red_param(data.get("red"))
            return HTTPStatus.OK, integ.quitar_olts(self.store, red_id, olts_field(data), user)
        if path == "/api/integracion/importacion/deshacer" and method == "POST":
            data = self.read_json()
            red_id = self.red_param(data.get("red"))
            lote = int_value(data.get("version"), "version")
            if lote <= 0:
                raise ApiError(HTTPStatus.BAD_REQUEST, "version inválida.")
            return HTTPStatus.OK, self.store.deshacer_importacion(red_id, lote, user)
        if path == "/api/integracion/nap" and method == "GET":
            return HTTPStatus.OK, integ.nap(self.store, self.element_of_type(q("elemento"), "nap"), q("refrescar") == "1",
                                           q("candidatas") == "1")
        if path == "/api/integracion/cliente" and method == "GET":
            return HTTPStatus.OK, integ.cliente(self.store, self.element_of_type(q("elemento"), "cliente"),
                                               q("refrescar") == "1")
        if method == "POST" and path in ("/api/integracion/nap/medir", "/api/integracion/cliente/medir",
                                         "/api/integracion/nap/importar", "/api/integracion/vincular",
                                         "/api/integracion/desvincular"):
            data = self.read_json()
            if path == "/api/integracion/nap/medir":
                return HTTPStatus.OK, integ.medir_nap(self.element_of_type(data.get("elemento"), "nap"))
            if path == "/api/integracion/cliente/medir":
                return HTTPStatus.OK, integ.medir_cliente(self.store, self.element_of_type(data.get("elemento"), "cliente"))
            if path == "/api/integracion/vincular":
                row = self.element_of_type(data.get("cliente"), "cliente")
                return HTTPStatus.OK, integ.vincular(self.store, row, contrato_field(data), user)
            if path == "/api/integracion/desvincular":
                row = self.element_of_type(data.get("cliente"), "cliente")
                deshacer = data.get("deshacer", False)
                if not isinstance(deshacer, bool):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "deshacer tiene que ser true o false.")
                return HTTPStatus.OK, integ.desvincular(self.store, row, contrato_field(data), user, deshacer)
            row = self.element_of_type(data.get("elemento"), "nap")
            return HTTPStatus.OK, integ.importar(self.store, row, contratos_field(data), user)
        raise ApiError(HTTPStatus.NOT_FOUND, "No existe esa ruta.")

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")


def read_secret(path: str) -> str:
    try:
        with open(path, encoding="ascii") as f:
            value = f.read().strip()
    except (OSError, UnicodeDecodeError) as err:
        raise SystemExit(f"No se pudo leer la clave compartida con nginx ({path}): {err}")
    if len(value) < 32:
        raise SystemExit(f"La clave compartida con nginx ({path}) es demasiado corta.")
    return value


def ruta_integraciones(db_path: str, archivo: str = "") -> str:
    """integraciones.json va junto a la base de la red."""
    return archivo or os.path.join(os.path.dirname(os.path.abspath(db_path)), "integraciones.json")


def serve(db_path: str, host: str, port: int, secret_path: str = "", integraciones: str = ""):
    Handler.secreto = read_secret(secret_path) if secret_path else ""
    Handler.store = Store(db_path)
    Handler.integraciones = Integraciones(ruta_integraciones(db_path, integraciones))
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    log.info("escuchando en http://%s:%d, base %s", host, port, db_path)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


# --------------------------------------------------- comando "integraciones"
#
# Se usa desde el servidor (el instalador deja /srv/ftth/bin/integraciones, que lo
# corre como el usuario del servicio). Así el token se escribe en la terminal del
# servidor y nunca pasa por el visor ni por un chat.

def leer_config(ruta: str) -> dict:
    try:
        with open(ruta, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        data = {}
    except (OSError, ValueError) as err:
        raise SystemExit(f"No se pudo leer {ruta}: {err}")
    if not isinstance(data, dict):
        data = {}
    if not isinstance(data.get("redes"), dict):
        data["redes"] = {}
    return data


def guardar_config(ruta: str, data: dict):
    """Escribe el archivo de una vez (a un temporario que después lo reemplaza),
    legible solo por su dueño: tiene el token."""
    fd, tmp = tempfile.mkstemp(prefix=".integraciones-", suffix=".tmp", dir=os.path.dirname(os.path.abspath(ruta)))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, ruta)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def elegir_red(store: Store, texto) -> dict:
    redes = store.networks()
    texto = (texto or "").strip()
    if not texto:
        raise SystemExit("Indicá la red (su nombre o su número). Redes: "
                         + (", ".join(f"{r['nombre']} ({r['id']})" for r in redes) or "ninguna todavía") + ".")
    red = next((r for r in redes if (texto.isdigit() and r["id"] == int(texto)) or r["nombre"].lower() == texto.lower()), None)
    if red is None:
        raise SystemExit(f"No hay una red «{texto}». Redes: "
                         + (", ".join(f"{r['nombre']} ({r['id']})" for r in redes) or "ninguna todavía") + ".")
    return red


def fecha_local(iso) -> str:
    """Fecha y hora en la zona del servidor, diciendo cuál ("(UTC)", "(UTC−3)"): el
    visor muestra las mismas lecturas en la hora del teléfono o la computadora."""
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return str(iso)
    local = d.astimezone()
    horas = (local.utcoffset() or timedelta(0)).total_seconds() / 3600
    zona = f"UTC{'+' if horas > 0 else '−'}{abs(horas):g}" if horas else "UTC"
    return f"{local:%d/%m/%Y %H:%M} ({zona})"


def horas_desde(iso):
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - d).total_seconds() / 3600


def cli_ver(store: Store, ruta: str) -> int:
    data = leer_config(ruta)
    print(f"Archivo: {ruta}")
    for red in store.networks():
        cfg = data["redes"].get(str(red["id"])) or {}
        w, p = cfg.get("wispro") or {}, cfg.get("panel") or {}
        if not w and not p:
            print(f"  {red['nombre']} (red {red['id']}): sin integraciones")
            continue
        print(f"  {red['nombre']} (red {red['id']})")
        if w:
            token = str(w.get("token") or "")
            print(f"    Wispro: conectada (token que termina en …{token[-4:]})")
        if p:
            # Igual que la API: sin OLT indicada, solo sirve si el panel tiene una sola.
            ids = Panel(str(p.get("url") or ""), p.get("olts")).olts_red
            olts = f"OLT {', '.join(str(x) for x in ids)}" if ids else "sin OLT elegida: sirve solo si el panel tiene una"
            print(f"    Panel de la OLT: {p.get('url')} ({olts})")
    return 0


def cli_wispro(store: Store, ruta: str, args) -> int:
    red = elegir_red(store, args.red)
    if args.token_stdin:
        token = sys.stdin.readline().strip()
    else:
        token = getpass.getpass("Token de la API de Wispro (no se ve al escribir; está en Wispro, "
                                "Configuración avanzada → ISP): ").strip()
    if not token or len(token) > 512 or any(c.isspace() for c in token):
        raise SystemExit("Ese token no parece válido. No se guardó nada.")
    w = Wispro(token, args.wispro_url)
    print("Probando el token…")
    try:
        naps, contratos = w.total("/naps"), w.total("/contracts")
    except IntegracionError as err:
        raise SystemExit(f"No se pudo usar Wispro: {err}. No se guardó nada.")
    try:
        olts = [str(o.get("name")) for o in w.todo("/olts")]
    except IntegracionError:
        olts = []  # la API de la red se arregla sin la lista de OLTs
    print(f"Wispro respondió: {naps} NAPs, {contratos} contratos" + (f", OLT: {', '.join(olts)}" if olts else "") + ".")
    data = leer_config(ruta)
    cfg = {"token": token}
    if args.wispro_url.rstrip("/") != WISPRO_URL:
        cfg["url"] = args.wispro_url.rstrip("/")
    data["redes"].setdefault(str(red["id"]), {})["wispro"] = cfg
    guardar_config(ruta, data)
    print(f"Listo: {red['nombre']} quedó conectada con Wispro. En el visor, abrí una NAP para ver sus clientes.")
    return 0


def cli_panel(store: Store, ruta: str, args) -> int:
    red = elegir_red(store, args.red)
    url = (args.extra or "").strip().rstrip("/")
    if not re.fullmatch(r"https?://[A-Za-z0-9.\-\[\]:]+(/[^\s]*)?", url):
        raise SystemExit("Indicá la dirección del panel, por ejemplo: http://10.10.0.230:8080")
    try:
        olts = Panel(url).olts()
    except IntegracionError as err:
        raise SystemExit(f"El panel de la OLT {err}. No se guardó nada.")
    if not olts:
        raise SystemExit("El panel no tiene OLTs. No se guardó nada.")
    print("OLTs del panel:")
    for o in olts:
        print(f"  {o.get('id'):>6}  {o.get('name')}  ({o.get('ont_count', '?')} ONTs)")
    hay = [o.get("id") for o in olts]
    ids = args.olt
    if not ids:
        if len(olts) == 1:
            ids = hay
        else:
            # Sin respuesta por defecto: el panel puede tener OLTs de otras empresas.
            if not sys.stdin.isatty():
                raise SystemExit("El panel tiene varias OLTs: indicá cuáles son de esta red con --olt (se puede repetir).")
            resp = input(f"¿Qué OLTs son de {red['nombre']}? Escribí sus números, separados por coma: ").strip()
            ids = [int(x) for x in re.findall(r"\d+", resp)]
            if not ids:
                raise SystemExit("No se indicó ninguna OLT. No se guardó nada.")
    faltan = [i for i in ids if i not in hay]
    if faltan:
        raise SystemExit(f"El panel no tiene la OLT {', '.join(str(i) for i in faltan)}. No se guardó nada.")
    data = leer_config(ruta)
    data["redes"].setdefault(str(red["id"]), {})["panel"] = {"url": url, "olts": sorted(set(ids))}
    guardar_config(ruta, data)
    nombres = [str(o.get("name")) for o in olts if o.get("id") in ids]
    print(f"Listo: {red['nombre']} toma las potencias de {', '.join(nombres)}.")
    return 0


def cli_quitar(store: Store, ruta: str, args) -> int:
    red = elegir_red(store, args.red)
    que = (args.extra or "").strip().lower()
    if que not in ("", "wispro", "panel"):
        raise SystemExit("Qué quitar: wispro, panel o nada (las dos).")
    data = leer_config(ruta)
    cfg = data["redes"].get(str(red["id"])) or {}
    for k in ([que] if que else ["wispro", "panel"]):
        cfg.pop(k, None)
    if cfg:
        data["redes"][str(red["id"])] = cfg
    else:
        data["redes"].pop(str(red["id"]), None)
    guardar_config(ruta, data)
    print(f"Listo: {red['nombre']} ya no usa {que or 'Wispro ni el panel de la OLT'}.")
    return 0


def cli_probar(store: Store, ruta: str, args) -> int:
    red = elegir_red(store, args.red)
    integ = Integraciones(ruta)
    estado = integ.estado(red["id"])
    if not any(estado.values()):
        print(f"{red['nombre']} no está conectada con Wispro ni con el panel de la OLT.")
        return 1
    falla = 0
    dw = dp = None
    if estado["wispro"]:
        t = time.monotonic()
        try:
            dw, _ = integ.datos_wispro(red["id"])
            print(f"Wispro: {len(dw.naps)} NAPs, {len(dw.contratos)} contratos y {len(dw.clientes)} clientes "
                  f"({time.monotonic() - t:.1f} s).")
        except IntegracionError as err:
            print(f"Wispro: {err}.")
            falla = 1
    if estado["panel"]:
        t = time.monotonic()
        try:
            dp, _ = integ.datos_panel(red["id"])
            linea = f"Panel de la OLT: {dp.total} ONTs de {', '.join(dp.olts)} ({time.monotonic() - t:.1f} s)"
            if dp.leido:
                horas = horas_desde(dp.leido)
                linea += f"; última lectura {fecha_local(dp.leido)}"
                if horas is not None and horas > 0.5:
                    cuanto = f"{round(horas)} hora{'s' if round(horas) != 1 else ''}" if horas < 48 else f"{round(horas / 24)} días"
                    linea += f". Ojo: hace {cuanto} que el panel no lee la OLT"
            print(linea + ".")
        except IntegracionError as err:
            print(f"Panel de la OLT: {err}.")
            falla = 1
    naps = store.conn().execute(
        "SELECT id, nombre, lon, lat, datos FROM elementos WHERE red_id = ? AND tipo = 'nap' AND borrado IS NULL ORDER BY nombre",
        (red["id"],)).fetchall()
    if dw is not None:
        sin = [r["nombre"] or f"#{r['id']}" for r in naps if caja_de_wispro(dw, r)[0] is None]
        faltan = f"; sin encontrar (vinculalas desde su ficha): {', '.join(sin[:12])}{'…' if len(sin) > 12 else ''}"
        print(f"Cajas NAP en traza: {len(naps)}; encontradas en Wispro: {len(naps) - len(sin)}{faltan if sin else ''}.")
        cruce = Cruce(dw, store.clientes_red(red["id"]))
        items = list(cruce.items.values())
        ubicados = [x for x in cruce.de_contrato.values() if x.get("id") or x.get("repetidos")]
        repetidos = sum(1 for x in cruce.de_contrato.values() if x.get("repetidos"))
        dudosos = sum(1 for x in cruce.de_contrato.values() if x.get("dudosos"))
        print(f"Clientes en traza: {len(cruce.traza.todos)}; contratos de Wispro que ya están en el mapa: "
              f"{len(ubicados)} de {len(items)}"
              + (f"; repetidos en el mapa: {repetidos}" if repetidos else "")
              + (f"; para confirmar desde la caja: {dudosos}" if dudosos else "") + ".")
    if dw is not None and dp is not None:
        items = [dw.contrato(c) for c in dw.contratos]
        con_sn = [i for i in items if i["sn"]]
        en_panel = sum(1 for i in con_sn if dp.ont(i["sn"])[0])
        sin_sn = [i for i in items if not i["sn"] and i["numero"] is not None]
        por_numero = sum(1 for i in sin_sn if dp.ont(None, i["numero"], dw.por_sn)[0])
        print(f"Contratos con ONT en Wispro: {len(con_sn)}; con su ONT en el panel: {en_panel}. "
              f"Sin número de serie en Wispro: {len(sin_sn)}; encontrados en el panel por el número de contrato: {por_numero}.")
    return falla


def cli_integraciones(args) -> int:
    if not os.path.exists(args.db):
        raise SystemExit(f"No existe la base {args.db}.")
    if hasattr(os, "geteuid") and os.stat(args.db).st_uid != os.geteuid():
        raise SystemExit("Corré esto con: sudo /srv/ftth/bin/integraciones … (lo ejecuta como el usuario del servicio).")
    ruta = ruta_integraciones(args.db, args.archivo)
    if not ruta.endswith(".json") or os.path.abspath(ruta) == os.path.abspath(args.db):
        raise SystemExit("El archivo de integraciones tiene que ser un .json aparte.")
    store = Store(args.db)
    try:
        acciones = {"ver": lambda: cli_ver(store, ruta), "wispro": lambda: cli_wispro(store, ruta, args),
                    "panel": lambda: cli_panel(store, ruta, args), "quitar": lambda: cli_quitar(store, ruta, args),
                    "probar": lambda: cli_probar(store, ruta, args)}
        return acciones[args.accion]()
    finally:
        store.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="API de la red FTTH")
    parser.add_argument("--db", default=os.environ.get("FTTH_API_DB", "/srv/ftth/data/red.db"))
    sub = parser.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="atender pedidos (detrás de nginx)")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=int(os.environ.get("FTTH_API_PORT", "8901")))
    s.add_argument("--secreto", default="", help="archivo con la clave que nginx manda en X-Ftth-Secreto")
    s.add_argument("--integraciones", default="", help="archivo de integraciones (por defecto, junto a la base)")
    i = sub.add_parser("integraciones", help="conectar una red con Wispro y con el panel de la OLT",
                       description="ver | wispro RED | panel RED URL [--olt N] | quitar RED [wispro|panel] | probar RED")
    i.add_argument("accion", choices=("ver", "wispro", "panel", "quitar", "probar"))
    i.add_argument("red", nargs="?", help="nombre o número de la red")
    i.add_argument("extra", nargs="?", help="panel: su dirección (http://10.10.0.230:8080); quitar: wispro o panel")
    i.add_argument("--olt", type=int, action="append", help="panel: una OLT de esta red (se puede repetir)")
    i.add_argument("--token-stdin", action="store_true", help=argparse.SUPPRESS)
    i.add_argument("--wispro-url", default=WISPRO_URL, help=argparse.SUPPRESS)
    i.add_argument("--archivo", default="", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.cmd == "integraciones":
        logging.basicConfig(level=logging.WARNING, format="%(message)s", stream=sys.stderr)
        return cli_integraciones(args)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stdout)
    serve(args.db, args.host, args.port, args.secreto, args.integraciones)
    return 0


if __name__ == "__main__":
    sys.exit(main())
