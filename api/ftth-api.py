#!/usr/bin/env python3
"""API de la red FTTH: redes, elementos, cables y cartas de empalme.

Un solo archivo, sin dependencias fuera de la biblioteca estándar. Guarda todo
en SQLite y atiende en 127.0.0.1 detrás de nginx, que solo deja pasar pedidos
con sesión y agrega dos cabeceras: X-Usuario (la obtiene de ftth-auth.py) y
X-Ftth-Secreto, una clave que comparten nginx y este servicio para que ningún
otro programa de la máquina pueda hablarle a la API haciéndose pasar por nginx.

  GET    /api/salud                    el servicio está vivo (sin sesión): esquema de la base y, con
                                       la clave de nginx, el código del programa que atiende
  GET    /api/yo                       quién está conectado
  GET    /api/redes                    redes (una por cliente o despliegue)
  POST   /api/redes                    {nombre}
  PUT    /api/redes/ID                 {nombre}
  GET    /api/red?red=ID               toda la red (GeoJSON, equipos y uniones) y la versión actual
  GET    /api/cambios?red=ID&desde=V   lo que cambió después de la versión V (incluye bajas)
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

Extremos de una unión, siempre dentro de un elemento:
  cCABLE:LADO:FIBRA   fibra de un cable; LADO a = el tramo hacia el comienzo del
                      cable, b = el tramo hacia el final (un cable que pasa por el
                      elemento tiene los dos; uno que empieza o termina, uno solo)
  qEQUIPO:e:N         entrada N de un splitter
  qEQUIPO:s:N         salida N de un splitter o puerto PON N de una OLT

PUT y DELETE aceptan la versión que el usuario tenía a la vista: si mientras
tanto alguien cambió ese objeto, la respuesta es 409 con el estado actual.

Uso:
  ftth-api.py serve [--db RUTA] [--port 8901] [--secreto ARCHIVO]
"""

import argparse
import hashlib
import hmac
import json
import logging
import math
import os
import re
import sqlite3
import sys
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

MAX_BODY = 256 * 1024
MAX_NOMBRE = 80
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
        out = {"id": row["id"], "borrado": True, "modificado_por": row["modificado_por"], "version": row["version"]}
        if "elemento_id" in row.keys():
            out["elemento"] = row["elemento_id"]
        return out

    def network(self, red_id: int) -> dict:
        c = self.conn()
        # Lectura consistente: todo de un mismo momento.
        c.execute("BEGIN")
        try:
            version = self.version()
            rows = {
                tabla: c.execute(
                    f"SELECT * FROM {tabla} WHERE red_id = ? AND borrado IS NULL ORDER BY id", (red_id,)
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

    def changes(self, red_id: int, since: int) -> dict:
        c = self.conn()
        c.execute("BEGIN")
        try:
            version = self.version()
            rows = {
                tabla: c.execute(
                    f"SELECT * FROM {tabla} WHERE red_id = ? AND version > ? ORDER BY version, id", (red_id, since)
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


# ----------------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "ftth-api/1"
    store: Store = None
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

    def red_param(self, value) -> int:
        try:
            red_id = int_value(value, "red")
        except ApiError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Falta indicar la red.")
        if self.store.network_info(red_id) is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "No existe esa red.")
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
            return HTTPStatus.OK, {"usuario": user}

        if path == "/api/redes":
            if method == "GET":
                return HTTPStatus.OK, {"redes": store.networks()}
            if method == "POST":
                nombre = text_field(self.read_json(), "nombre", MAX_NOMBRE, required=True)
                if not nombre:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "La red necesita un nombre.")
                return HTTPStatus.CREATED, {"red": store.add_network(nombre, user)}
        red_id = self.route_id(path, "/api/redes/")
        if red_id is not None and method == "PUT":
            nombre = text_field(self.read_json(), "nombre", MAX_NOMBRE, required=True)
            if not nombre:
                raise ApiError(HTTPStatus.BAD_REQUEST, "La red necesita un nombre.")
            return HTTPStatus.OK, {"red": store.rename_network(red_id, nombre, user)}

        if path == "/api/red" and method == "GET":
            red_id = self.red_param(q("red"))
            payload = store.network(red_id)
            payload["red"] = store.network_info(red_id)
            return HTTPStatus.OK, payload

        if path == "/api/cambios" and method == "GET":
            red_id = self.red_param(q("red"))
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
            if method == "PUT":
                data = self.read_json()
                return HTTPStatus.OK, store.update_cable(
                    cable_id, cable_fields(data, creating=False), version_field(data.get("version")), user)
            if method == "DELETE":
                return HTTPStatus.OK, store.delete_cable(cable_id, version_field(q("version")), user)

        if path == "/api/equipos" and method == "POST":
            data = self.read_json()
            return HTTPStatus.CREATED, store.add_equipo(
                self.element_param(data.get("elemento")), equipo_fields(data, creating=True), user)
        equipo_id = self.route_id(path, "/api/equipos/")
        if equipo_id is not None:
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
                self.element_param(data.get("elemento")), pares_field(data), tipo, user)
        if path == "/api/fusiones/borrar" and method == "POST":
            return HTTPStatus.OK, store.delete_fusiones(ids_field(self.read_json()), None, user)
        fusion_id = self.route_id(path, "/api/fusiones/")
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


def serve(db_path: str, host: str, port: int, secret_path: str = ""):
    Handler.secreto = read_secret(secret_path) if secret_path else ""
    Handler.store = Store(db_path)
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    log.info("escuchando en http://%s:%d, base %s", host, port, db_path)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="API de la red FTTH")
    parser.add_argument("--db", default=os.environ.get("FTTH_API_DB", "/srv/ftth/data/red.db"))
    sub = parser.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="atender pedidos (detrás de nginx)")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=int(os.environ.get("FTTH_API_PORT", "8901")))
    s.add_argument("--secreto", default="", help="archivo con la clave que nginx manda en X-Ftth-Secreto")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stdout)
    serve(args.db, args.host, args.port, args.secreto)
    return 0


if __name__ == "__main__":
    sys.exit(main())
