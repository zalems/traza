#!/usr/bin/env python3
"""API de la red FTTH: redes, elementos puntuales y cables.

Un solo archivo, sin dependencias fuera de la biblioteca estándar. Guarda todo
en SQLite y atiende en 127.0.0.1 detrás de nginx, que solo deja pasar pedidos
con sesión y agrega dos cabeceras: X-Usuario (la obtiene de ftth-auth.py) y
X-Ftth-Secreto, una clave que comparten nginx y este servicio para que ningún
otro programa de la máquina pueda hablarle a la API haciéndose pasar por nginx.

  GET    /api/salud                    el servicio está vivo (sin sesión)
  GET    /api/yo                       quién está conectado
  GET    /api/redes                    redes (una por cliente o despliegue)
  POST   /api/redes                    {nombre}
  PUT    /api/redes/ID                 {nombre}
  GET    /api/red?red=ID               toda la red (GeoJSON) y la versión actual
  GET    /api/cambios?red=ID&desde=V   lo que cambió después de la versión V (incluye bajas)
  POST   /api/elementos                {red, tipo, nombre, estado, lon, lat, datos, notas}
  PUT    /api/elementos/ID             los mismos campos, todos opcionales; mover = lon y lat
  DELETE /api/elementos/ID?version=V   baja lógica; los cables pegados quedan sueltos en ese punto
  POST   /api/cables                   {red, nombre, tipo, fibras, estado, tendido, coords, nodos, datos, notas}
  PUT    /api/cables/ID
  DELETE /api/cables/ID?version=V
  GET    /api/historial?red=ID&limite=N   últimos cambios (quién, qué, cuándo)

PUT y DELETE aceptan la versión que el usuario tenía a la vista: si mientras
tanto alguien cambió ese objeto, la respuesta es 409 con el estado actual.

Uso:
  ftth-api.py serve [--db RUTA] [--port 8901] [--secreto ARCHIVO]
"""

import argparse
import hmac
import json
import logging
import math
import os
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

TIPOS_ELEMENTO = ("nodo", "poste", "caja", "nap", "botella", "cliente", "reserva")
TIPOS_CABLE = ("troncal", "distribucion", "bajada")
ESTADOS = ("proyectado", "instalado", "activo", "baja")
TENDIDOS = ("aereo", "subterraneo", "fachada")

# Versión del esquema de la base (PRAGMA user_version). Cada cambio de
# estructura suma un paso en MIGRACIONES.
ESQUEMA = 1

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
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def haversine_m(a, b) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(h)))


def line_length_m(coords) -> float:
    return sum(haversine_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


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
    def tombstone(row) -> dict:
        return {"id": row["id"], "borrado": True, "modificado_por": row["modificado_por"], "version": row["version"]}

    def network(self, red_id: int) -> dict:
        c = self.conn()
        # Lectura consistente: elementos, cables y versión de un mismo momento.
        c.execute("BEGIN")
        try:
            version = self.version()
            elements = c.execute(
                "SELECT * FROM elementos WHERE red_id = ? AND borrado IS NULL ORDER BY id", (red_id,)
            ).fetchall()
            cables = c.execute(
                "SELECT * FROM cables WHERE red_id = ? AND borrado IS NULL ORDER BY id", (red_id,)
            ).fetchall()
        finally:
            c.execute("COMMIT")
        return {
            "version": version,
            "elementos": {"type": "FeatureCollection", "features": [self.element_feature(r) for r in elements]},
            "cables": {"type": "FeatureCollection", "features": [self.cable_feature(r) for r in cables]},
        }

    def changes(self, red_id: int, since: int) -> dict:
        c = self.conn()
        c.execute("BEGIN")
        try:
            version = self.version()
            elements = c.execute(
                "SELECT * FROM elementos WHERE red_id = ? AND version > ? ORDER BY version", (red_id, since)
            ).fetchall()
            cables = c.execute(
                "SELECT * FROM cables WHERE red_id = ? AND version > ? ORDER BY version", (red_id, since)
            ).fetchall()
        finally:
            c.execute("COMMIT")
        return {
            "version": version,
            "elementos": [self.tombstone(r) if r["borrado"] else self.element_feature(r) for r in elements],
            "cables": [self.tombstone(r) if r["borrado"] else self.cable_feature(r) for r in cables],
        }

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

    # --- elementos
    def get_element(self, element_id: int):
        return self.conn().execute("SELECT * FROM elementos WHERE id = ? AND borrado IS NULL", (element_id,)).fetchone()

    def add_element(self, red_id: int, fields: dict, usuario: str) -> dict:
        t = now_iso()
        self.begin()
        try:
            v = self.next_version()
            cur = self.conn().execute(
                "INSERT INTO elementos (red_id, tipo, nombre, estado, lon, lat, datos, notas, creado, creado_por, "
                "modificado, modificado_por, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    red_id, fields["tipo"], fields.get("nombre", ""), fields.get("estado", "instalado"),
                    fields["lon"], fields["lat"], json.dumps(fields.get("datos", {}), ensure_ascii=False),
                    fields.get("notas", ""), t, usuario, t, usuario, v,
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

    def update_element(self, element_id: int, fields: dict, expected, usuario: str) -> dict:
        self.begin()
        try:
            row = self.get_element(element_id)
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese elemento ya no existe: lo borró otro usuario.")
            self.check_version(row, expected, self.element_feature)
            v = self.next_version()
            t = now_iso()
            merged = {
                "tipo": fields.get("tipo", row["tipo"]),
                "nombre": fields.get("nombre", row["nombre"]),
                "estado": fields.get("estado", row["estado"]),
                "lon": fields.get("lon", row["lon"]),
                "lat": fields.get("lat", row["lat"]),
                "datos": json.dumps(fields["datos"], ensure_ascii=False) if "datos" in fields else row["datos"],
                "notas": fields.get("notas", row["notas"]),
            }
            self.conn().execute(
                "UPDATE elementos SET tipo = ?, nombre = ?, estado = ?, lon = ?, lat = ?, datos = ?, notas = ?, "
                "modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                (merged["tipo"], merged["nombre"], merged["estado"], merged["lon"], merged["lat"], merged["datos"],
                 merged["notas"], t, usuario, v, element_id),
            )
            moved = (merged["lon"], merged["lat"]) != (row["lon"], row["lat"])
            cables = self._follow_element(element_id, [merged["lon"], merged["lat"]], v, t, usuario) if moved else []
            self.log_change(row["red_id"], usuario, "mover" if moved else "editar", "elementos", element_id,
                            {"tipo": merged["tipo"], "nombre": merged["nombre"], "antes": self.element_feature(row)})
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
            self.check_version(row, expected, self.element_feature)
            v = self.next_version()
            t = now_iso()
            self.conn().execute(
                "UPDATE elementos SET borrado = ?, modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                (t, t, usuario, v, element_id),
            )
            cables = self._detach_element(element_id, v, t, usuario)
            self.log_change(row["red_id"], usuario, "borrar", "elementos", element_id,
                            {"tipo": row["tipo"], "nombre": row["nombre"], "antes": self.element_feature(row)})
            self.commit()
        except Exception:
            self.rollback()
            raise
        return {"ok": True, "elementos": [{"id": element_id, "borrado": True, "modificado_por": usuario, "version": v}],
                "cables": cables, "version": v}

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
            f"SELECT id, lon, lat FROM elementos WHERE red_id = ? AND borrado IS NULL AND id IN ({marks})",
            (red_id, *ids),
        ).fetchall()
        where = {r["id"]: [r["lon"], r["lat"]] for r in rows}
        missing = [i for i in ids if i not in where]
        if missing:
            raise ApiError(HTTPStatus.CONFLICT,
                           "El cable pasa por un elemento que ya no existe (lo borró otro usuario).",
                           {"faltan": missing})
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
                "INSERT INTO cables (red_id, tipo, nombre, fibras, estado, tendido, coords, nodos, largo_m, datos, notas, "
                "creado, creado_por, modificado, modificado_por, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    red_id, fields.get("tipo", "distribucion"), fields.get("nombre", ""), fields.get("fibras", 12),
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

    def update_cable(self, cable_id: int, fields: dict, expected, usuario: str) -> dict:
        self.begin()
        try:
            row = self.get_cable(cable_id)
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Ese cable ya no existe: lo borró otro usuario.")
            self.check_version(row, expected, self.cable_feature)
            v = self.next_version()
            t = now_iso()
            if "coords" in fields:
                nodos = fields["nodos"]
                coords = self._anchor(row["red_id"], fields["coords"], nodos)
                self._save_anchors(cable_id, nodos)
            else:
                coords, nodos = json.loads(row["coords"]), json.loads(row["nodos"])
            self.conn().execute(
                "UPDATE cables SET tipo = ?, nombre = ?, fibras = ?, estado = ?, tendido = ?, coords = ?, nodos = ?, "
                "largo_m = ?, datos = ?, notas = ?, modificado = ?, modificado_por = ?, version = ? WHERE id = ?",
                (
                    fields.get("tipo", row["tipo"]), fields.get("nombre", row["nombre"]), fields.get("fibras", row["fibras"]),
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
            self.log_change(row["red_id"], usuario, "borrar", "cables", cable_id,
                            {"tipo": row["tipo"], "nombre": row["nombre"], "antes": self.cable_feature(row)})
            self.commit()
        except Exception:
            self.rollback()
            raise
        return {"ok": True, "cables": [{"id": cable_id, "borrado": True, "modificado_por": usuario, "version": v}],
                "version": v}


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


def int_value(value, name: str):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{name} tiene que ser un número entero.")
    if isinstance(value, str) and not (value.isascii() and value.lstrip("-").isdigit() and len(value) <= 20):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{name} tiene que ser un número entero.")
    number = int(value)
    if abs(number) > MAX_ENTERO:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{name} está fuera de rango.")
    return number


def check_text(value: str, name: str) -> str:
    """Rechaza texto que no se puede guardar como UTF-8 (por ejemplo, surrogates sueltos)."""
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{name} tiene caracteres inválidos.")
    return value


def coord_pair(lon, lat):
    if isinstance(lon, bool) or isinstance(lat, bool):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Coordenadas inválidas.")
    try:
        lon, lat = float(lon), float(lat)
    except (TypeError, ValueError):
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
    return out


def cable_fields(data: dict, creating: bool) -> dict:
    out = {}
    for key, choices in (("tipo", TIPOS_CABLE), ("estado", ESTADOS), ("tendido", TENDIDOS)):
        value = choice_field(data, key, choices)
        if value is not None:
            out[key] = value
    for key, limit in (("nombre", MAX_NOMBRE), ("notas", MAX_NOTAS)):
        value = text_field(data, key, limit)
        if value is not None:
            out[key] = value
    if "fibras" in data:
        fibras = int_value(data["fibras"], "fibras")
        if not 1 <= fibras <= MAX_FIBRAS:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"fibras tiene que estar entre 1 y {MAX_FIBRAS}.")
        out["fibras"] = fibras
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
        for node in nodos:
            if node is not None and not (isinstance(node, int) and not isinstance(node, bool) and 0 < node <= MAX_ENTERO):
                raise ApiError(HTTPStatus.BAD_REQUEST, "nodos inválidos.")
        if all(clean[i] == clean[0] for i in range(len(clean))):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Los puntos del cable están todos en el mismo lugar.")
        out["coords"], out["nodos"] = clean, nodos
    datos = datos_field(data)
    if datos is not None:
        out["datos"] = datos
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
            data = json.loads(self.rfile.read(length).decode("utf-8"))
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
            if path == "/api/salud" and method == "GET":
                self.send_json(HTTPStatus.OK, {"ok": True})
                return
            if self.secreto and not hmac.compare_digest(
                    (self.headers.get("X-Ftth-Secreto") or "").encode(), self.secreto.encode()):
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
