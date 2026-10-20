#!/usr/bin/env python3
"""Servicio de sesión de la plataforma FTTH.

Un solo archivo, sin dependencias fuera de la biblioteca estándar. Guarda
usuarios y sesiones en SQLite y atiende en 127.0.0.1 detrás de nginx:

  GET  /auth/check    nginx lo consulta (auth_request) antes de servir cada
                      archivo: 200 si la cookie de sesión vale, 401 si no.
                      Responde X-Usuario y X-Redes (qué redes puede ver: "*" todas,
                      "1,3" esas, "-" ninguna), que nginx le pasa a la API.
  POST /auth/login    usuario y contraseña (JSON) -> cookie de sesión.
  POST /auth/logout   cierra la sesión.
  GET  /auth/session  quién está conectado y si administra (para la interfaz).
  POST /auth/clave    {actual, nueva}: el usuario conectado cambia su contraseña.
  GET  /auth/health   el servicio está vivo.

  Solo para quien administra (el panel de usuarios del visor):
  GET    /auth/usuarios          lista: nombre, redes, cuándo entró por última vez.
  POST   /auth/usuarios          {nombre, clave, redes}: redes null = administra, [] = ninguna.
  PUT    /auth/usuarios/NOMBRE   {clave} y/o {redes}: cambiar la contraseña (cierra sus sesiones) o las redes.
  DELETE /auth/usuarios/NOMBRE   quitar el usuario (no el propio).

Uso:
  ftth-auth.py serve  [--db RUTA] [--port 8900]
  ftth-auth.py usuarios listar | agregar NOMBRE [--red RED …] | clave NOMBRE | quitar NOMBRE
               | redes NOMBRE (RED … | --todas)                       [--db RUTA]

Un usuario administra (ve todas las redes, crea redes y les cambia el nombre, y
maneja los usuarios) o ve solo las redes que se le asignaron. Los que existían
antes de 0.8.0 quedan como administradores. Las redes se nombran como en el
visor o por su número (se leen de la base de la red, red.db, si está junto a la
de usuarios).
"""

import argparse
import base64
import getpass
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

COOKIE = "ftth_sesion"
SESSION_DAYS = 30            # duración de una sesión sin uso
EXTEND_AFTER_HOURS = 6       # cada cuánto se renueva el vencimiento de una sesión activa
MAX_FAILURES = 8             # intentos fallidos por IP o por usuario…
FAILURE_WINDOW_MIN = 15      # …en esta ventana, antes de bloquear por el mismo lapso
FAILURE_DELAY_S = 0.4        # pausa tras un intento fallido, para frenar la fuerza bruta
MAX_BODY = 8192
MIN_PASSWORD = 8
NOMBRE_USUARIO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@-]{1,63}$")  # sin espacios; 2 a 64 caracteres

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1

log = logging.getLogger("ftth-auth")


# ------------------------------------------------------------------ contraseñas

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return "scrypt${}${}${}${}${}".format(
        SCRYPT_N, SCRYPT_R, SCRYPT_P,
        base64.b64encode(salt).decode(), base64.b64encode(digest).decode(),
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        candidate = hashlib.scrypt(
            password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=32,
        )
        return hmac.compare_digest(candidate, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


# ------------------------------------------------------------------------- base

SCHEMA = """
CREATE TABLE IF NOT EXISTS usuarios (
    id      INTEGER PRIMARY KEY,
    nombre  TEXT NOT NULL UNIQUE,
    clave   TEXT NOT NULL,
    creado  TEXT NOT NULL,
    redes   TEXT                -- NULL: todas (administra); "1,3": solo esas; "": ninguna
);
CREATE TABLE IF NOT EXISTS sesiones (
    token_hash  TEXT PRIMARY KEY,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    creado      TEXT NOT NULL,
    visto       TEXT NOT NULL,
    vence       TEXT NOT NULL,
    ip          TEXT,
    agente      TEXT
);
CREATE INDEX IF NOT EXISTS sesiones_usuario ON sesiones(usuario_id);
"""


def now() -> datetime:
    return datetime.now(timezone.utc)


def redes_texto(redes):
    """Lista de ids de red -> lo que se guarda (None = todas)."""
    if redes is None:
        return None
    return ",".join(str(int(r)) for r in sorted({int(r) for r in redes}))


def redes_lista(texto):
    """Lo guardado -> None (todas) o lista de ids."""
    if texto is None:
        return None
    return [int(x) for x in str(texto).split(",") if x.strip().isdigit()]


def redes_cabecera(redes) -> str:
    """Lo que va en X-Redes: "*" todas, "1,3" esas, "-" ninguna."""
    if redes is None:
        return "*"
    return ",".join(str(r) for r in redes) if redes else "-"


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


class Store:
    """Acceso a la base. Una conexión por hilo; SQLite se encarga del resto."""

    def __init__(self, path: str):
        self.path = path
        self.local = threading.local()
        with self.conn() as c:
            c.executescript(SCHEMA)
            # 0.8.0: redes por usuario (las bases anteriores no tienen la columna).
            if "redes" not in {r["name"] for r in c.execute("PRAGMA table_info(usuarios)")}:
                c.execute("ALTER TABLE usuarios ADD COLUMN redes TEXT")

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
        """Cierra la conexión de este hilo (cada pedido corre en un hilo que después termina)."""
        c = getattr(self.local, "conn", None)
        if c is not None:
            c.close()
            self.local.conn = None

    # usuarios
    def list_users(self):
        return self.conn().execute(
            "SELECT u.nombre, u.creado, u.redes, "
            "(SELECT MAX(s.visto) FROM sesiones s WHERE s.usuario_id = u.id AND s.vence > ?) AS ultimo_acceso, "
            "(SELECT COUNT(*) FROM sesiones s WHERE s.usuario_id = u.id AND s.vence > ?) AS sesiones "
            "FROM usuarios u ORDER BY u.nombre COLLATE NOCASE",
            (iso(now()), iso(now())),
        ).fetchall()

    def get_user(self, name: str):
        return self.conn().execute("SELECT id, nombre, creado, redes FROM usuarios WHERE nombre = ?", (name,)).fetchone()

    def find_user_like(self, name: str):
        """El nombre tal como está guardado, sin distinguir mayúsculas; None si no existe."""
        row = self.conn().execute("SELECT nombre FROM usuarios WHERE lower(nombre) = lower(?)", (name,)).fetchone()
        return row["nombre"] if row else None

    def add_user(self, name: str, password: str, redes=None):
        """redes: None = todas (administra); lista de ids = solo esas."""
        self.conn().execute(
            "INSERT INTO usuarios (nombre, clave, creado, redes) VALUES (?, ?, ?, ?)",
            (name, hash_password(password), iso(now()), redes_texto(redes)),
        )

    def set_redes(self, name: str, redes) -> bool:
        return self.conn().execute("UPDATE usuarios SET redes = ? WHERE nombre = ?", (redes_texto(redes), name)).rowcount > 0

    def set_password(self, name: str, password: str) -> bool:
        cur = self.conn().execute("UPDATE usuarios SET clave = ? WHERE nombre = ?", (hash_password(password), name))
        if cur.rowcount:
            self.conn().execute(
                "DELETE FROM sesiones WHERE usuario_id = (SELECT id FROM usuarios WHERE nombre = ?)", (name,)
            )
        return cur.rowcount > 0

    def remove_user(self, name: str) -> bool:
        return self.conn().execute("DELETE FROM usuarios WHERE nombre = ?", (name,)).rowcount > 0  # sus sesiones caen con él

    def check_login(self, name: str, password: str):
        row = self.conn().execute("SELECT id, nombre, clave FROM usuarios WHERE nombre = ?", (name,)).fetchone()
        if row is None:
            # Mismo costo que una verificación real, para no delatar qué usuarios existen.
            verify_password(password, hash_password("x"))
            return None
        return row if verify_password(password, row["clave"]) else None

    # sesiones
    @staticmethod
    def token_hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def create_session(self, user_id: int, ip: str, agent: str) -> str:
        token = secrets.token_urlsafe(32)
        t = now()
        self.conn().execute(
            "INSERT INTO sesiones (token_hash, usuario_id, creado, visto, vence, ip, agente) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (self.token_hash(token), user_id, iso(t), iso(t), iso(t + timedelta(days=SESSION_DAYS)), ip, agent[:200]),
        )
        return token

    def session_user(self, token: str):
        """El usuario de la sesión ({"nombre", "redes"}), o None. Renueva el vencimiento de vez en cuando."""
        if not token:
            return None
        h = self.token_hash(token)
        row = self.conn().execute(
            "SELECT s.token_hash, s.visto, s.vence, u.id, u.nombre, u.redes FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id "
            "WHERE s.token_hash = ?",
            (h,),
        ).fetchone()
        if row is None:
            return None
        t = now()
        if parse_iso(row["vence"]) < t:
            self.conn().execute("DELETE FROM sesiones WHERE token_hash = ?", (h,))
            return None
        if t - parse_iso(row["visto"]) > timedelta(hours=EXTEND_AFTER_HOURS):
            self.conn().execute(
                "UPDATE sesiones SET visto = ?, vence = ? WHERE token_hash = ?",
                (iso(t), iso(t + timedelta(days=SESSION_DAYS)), h),
            )
        return {"id": row["id"], "nombre": row["nombre"], "redes": redes_lista(row["redes"])}

    def delete_session(self, token: str):
        if token:
            self.conn().execute("DELETE FROM sesiones WHERE token_hash = ?", (self.token_hash(token),))

    def purge_expired(self):
        self.conn().execute("DELETE FROM sesiones WHERE vence < ?", (iso(now()),))


# ----------------------------------------------------------- intentos fallidos

class Throttle:
    """Cuenta intentos fallidos por clave (IP o usuario) y bloquea un rato."""

    def __init__(self):
        self.failures = {}
        self.lock = threading.Lock()

    def blocked(self, key: str) -> bool:
        with self.lock:
            stamps = [s for s in self.failures.get(key, []) if s > time.time() - FAILURE_WINDOW_MIN * 60]
            self.failures[key] = stamps
            return len(stamps) >= MAX_FAILURES

    def failed(self, key: str):
        with self.lock:
            self.failures.setdefault(key, []).append(time.time())

    def clear(self, key: str):
        with self.lock:
            self.failures.pop(key, None)


# ----------------------------------------------------------------------- HTTP

class Rechazo(Exception):
    """Un pedido que no corresponde: el estado HTTP y el mensaje para la interfaz."""

    def __init__(self, status, mensaje):
        super().__init__(mensaje)
        self.status = status
        self.mensaje = mensaje


class Handler(BaseHTTPRequestHandler):
    server_version = "ftth-auth/1"
    store: Store = None
    throttle: Throttle = None

    # --- utilidades
    def log_message(self, fmt, *args):  # el registro va por logging, no por stderr suelto
        log.debug(fmt, *args)

    def client_ip(self) -> str:
        return self.headers.get("X-Real-IP") or self.client_address[0]

    def cookie_token(self) -> str:
        raw = self.headers.get("Cookie", "")
        for part in raw.split(";"):
            name, _, value = part.strip().partition("=")
            if name == COOKIE:
                return value.strip()
        return ""

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def same_origin(self) -> bool:
        """El pedido viene de esta misma página (defensa contra formularios de otros sitios)."""
        origin = self.headers.get("Origin") or self.headers.get("Referer")
        if not origin:
            return True  # clientes sin navegador (curl); la cookie SameSite ya cubre al navegador
        host = urlsplit(origin).hostname or ""
        expected = (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(":")[0]
        return host.lower() == expected.lower()

    def send_json(self, status: int, payload: dict, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra_headers or []):
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def cookie_header(self, token: str, max_age: int) -> str:
        secure = (self.headers.get("X-Forwarded-Proto") or "").lower() == "https"
        parts = [f"{COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}"]
        if secure:
            parts.append("Secure")
        return "; ".join(parts)

    # --- rutas
    def do_GET(self):
        self.atender("GET")

    def do_POST(self):
        self.atender("POST")

    def do_PUT(self):
        self.atender("PUT")

    def do_DELETE(self):
        self.atender("DELETE")

    def atender(self, method: str):
        try:
            self.rutear(method, urlsplit(self.path).path)
        except Rechazo as err:
            self.send_json(err.status, {"error": err.mensaje})
        except Exception:  # noqa: BLE001 - se informa y se sigue atendiendo
            log.exception("error atendiendo %s %s", method, self.path)
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Error interno del servidor."})
        finally:
            self.store.close()

    def rutear(self, method: str, path: str):
        if method == "GET" and path == "/auth/check":
            user = self.store.session_user(self.cookie_token())
            if user:
                self.send_response(HTTPStatus.OK)
                self.send_header("X-Usuario", user["nombre"])
                self.send_header("X-Redes", redes_cabecera(user["redes"]))
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "sin sesión"})
        elif method == "GET" and path == "/auth/session":
            user = self.store.session_user(self.cookie_token())
            if user:
                self.send_json(HTTPStatus.OK, {"usuario": user["nombre"], "administra": user["redes"] is None,
                                               "redes": user["redes"]})
            else:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "sin sesión"})
        elif method == "GET" and path == "/auth/health":
            self.send_json(HTTPStatus.OK, {"ok": True})
        elif method == "POST" and path == "/auth/login":
            self.login()
        elif method == "POST" and path == "/auth/logout":
            token = self.cookie_token()
            self.store.delete_session(token)
            self.send_json(HTTPStatus.OK, {"ok": True}, [("Set-Cookie", self.cookie_header("", 0))])
        elif method == "POST" and path == "/auth/clave":
            self.cambiar_clave_propia()
        elif path == "/auth/usuarios" and method in ("GET", "POST"):
            self.usuarios(method, None)
        elif path.startswith("/auth/usuarios/") and method in ("PUT", "DELETE"):
            self.usuarios(method, unquote(path[len("/auth/usuarios/"):]))
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "no existe"})

    # --- quién pide
    def sesion_actual(self) -> dict:
        user = self.store.session_user(self.cookie_token())
        if not user:
            raise Rechazo(HTTPStatus.UNAUTHORIZED, "sin sesión")
        return user

    def administrador(self) -> dict:
        user = self.sesion_actual()
        if user["redes"] is not None:
            raise Rechazo(HTTPStatus.FORBIDDEN, "Solo quien administra puede manejar los usuarios.")
        return user

    def cuerpo(self) -> dict:
        if not self.same_origin():
            raise Rechazo(HTTPStatus.FORBIDDEN, "origen no permitido")
        data = self.read_json()
        if not isinstance(data, dict):
            raise Rechazo(HTTPStatus.BAD_REQUEST, "Se esperaba un objeto JSON.")
        return data

    # --- usuarios (panel del visor)
    @staticmethod
    def usuario_json(row) -> dict:
        redes = redes_lista(row["redes"])
        return {"nombre": row["nombre"], "creado": row["creado"], "redes": redes, "administra": redes is None,
                "ultimo_acceso": row["ultimo_acceso"] if "ultimo_acceso" in row.keys() else None,
                "sesiones": row["sesiones"] if "sesiones" in row.keys() else 0}

    @staticmethod
    def validar_clave(valor) -> str:
        clave = str(valor if valor is not None else "")
        if len(clave) < MIN_PASSWORD:
            raise Rechazo(HTTPStatus.BAD_REQUEST, f"La contraseña tiene que tener al menos {MIN_PASSWORD} caracteres.")
        if len(clave) > 256:
            raise Rechazo(HTTPStatus.BAD_REQUEST, "La contraseña es demasiado larga.")
        return clave

    @staticmethod
    def validar_redes(valor):
        """null -> None (administra); lista de números -> esas redes ([] = ninguna)."""
        if valor is None:
            return None
        if not isinstance(valor, list) or len(valor) > 500:
            raise Rechazo(HTTPStatus.BAD_REQUEST, "redes tiene que ser null (administra) o una lista de redes.")
        ids = []
        for v in valor:
            if isinstance(v, bool) or not isinstance(v, (int, str)) or not str(v).isdigit() or int(v) <= 0:
                raise Rechazo(HTTPStatus.BAD_REQUEST, "Cada red va por su número.")
            ids.append(int(v))
        return ids

    def usuarios(self, method: str, nombre):
        actor = self.administrador()
        store = self.store
        if method == "GET":
            self.send_json(HTTPStatus.OK, {"usuarios": [self.usuario_json(r) for r in store.list_users()]})
            return
        if method == "POST":
            data = self.cuerpo()
            nombre = str(data.get("nombre") or "").strip()
            if not NOMBRE_USUARIO.match(nombre):
                raise Rechazo(HTTPStatus.BAD_REQUEST,
                              "El nombre de usuario lleva de 2 a 64 letras, números, puntos, guiones o @, sin espacios.")
            clave = self.validar_clave(data.get("clave"))
            redes = self.validar_redes(data.get("redes"))
            if store.find_user_like(nombre):
                raise Rechazo(HTTPStatus.CONFLICT, f"Ya existe el usuario {store.find_user_like(nombre)}.")
            store.add_user(nombre, clave, redes)
            log.info("usuarios: %s creó a %s (%s)", actor["nombre"], nombre, "administra" if redes is None else redes_cabecera(redes))
            self.send_json(HTTPStatus.CREATED, {"usuario": self.usuario_json(store.get_user(nombre))})
            return
        row = store.get_user(nombre or "")
        if row is None:
            raise Rechazo(HTTPStatus.NOT_FOUND, "No existe ese usuario.")
        if method == "DELETE":
            if not self.same_origin():
                raise Rechazo(HTTPStatus.FORBIDDEN, "origen no permitido")
            if row["nombre"] == actor["nombre"]:
                raise Rechazo(HTTPStatus.BAD_REQUEST, "No podés quitar tu propio usuario.")
            store.remove_user(row["nombre"])
            log.info("usuarios: %s quitó a %s", actor["nombre"], row["nombre"])
            self.send_json(HTTPStatus.OK, {"ok": True})
            return
        data = self.cuerpo()  # PUT
        if "clave" not in data and "redes" not in data:
            raise Rechazo(HTTPStatus.BAD_REQUEST, "Indicá la contraseña nueva o las redes.")
        if "redes" in data:
            redes = self.validar_redes(data.get("redes"))
            if row["nombre"] == actor["nombre"] and redes is not None:
                raise Rechazo(HTTPStatus.BAD_REQUEST, "No podés quitarte a vos mismo la administración.")
            store.set_redes(row["nombre"], redes)
            log.info("usuarios: %s cambió las redes de %s (%s)", actor["nombre"], row["nombre"],
                     "administra" if redes is None else redes_cabecera(redes))
        if "clave" in data:
            clave = self.validar_clave(data.get("clave"))
            store.set_password(row["nombre"], clave)
            log.info("usuarios: %s cambió la contraseña de %s", actor["nombre"], row["nombre"])
            if row["nombre"] == actor["nombre"]:
                # Cambiarse la propia cierra todas las sesiones: se abre una nueva para seguir.
                token = store.create_session(row["id"], self.client_ip(), self.headers.get("User-Agent", ""))
                self.send_json(HTTPStatus.OK, {"usuario": self.usuario_json(store.get_user(row["nombre"]))},
                               [("Set-Cookie", self.cookie_header(token, SESSION_DAYS * 86400))])
                return
        self.send_json(HTTPStatus.OK, {"usuario": self.usuario_json(store.get_user(row["nombre"]))})

    def cambiar_clave_propia(self):
        user = self.sesion_actual()
        data = self.cuerpo()
        actual = str(data.get("actual") or "")
        nueva = self.validar_clave(data.get("nueva"))
        if self.store.check_login(user["nombre"], actual) is None:
            time.sleep(FAILURE_DELAY_S)
            raise Rechazo(HTTPStatus.BAD_REQUEST, "La contraseña actual no es esa.")
        self.store.set_password(user["nombre"], nueva)
        token = self.store.create_session(user["id"], self.client_ip(), self.headers.get("User-Agent", ""))
        log.info("clave: %s cambió su contraseña", user["nombre"])
        self.send_json(HTTPStatus.OK, {"ok": True}, [("Set-Cookie", self.cookie_header(token, SESSION_DAYS * 86400))])

    def login(self):
        if not self.same_origin():
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "origen no permitido"})
            return
        data = self.read_json()
        if not isinstance(data, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "faltan usuario y contraseña"})
            return
        name = str(data.get("usuario") or "").strip()[:64]
        password = str(data.get("clave") or "")[:256]
        ip = self.client_ip()
        if not name or not password:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "faltan usuario y contraseña"})
            return
        if self.throttle.blocked("ip:" + ip) or self.throttle.blocked("usuario:" + name.lower()):
            log.warning("bloqueado por intentos fallidos: usuario=%s ip=%s", name, ip)
            self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": f"Demasiados intentos. Esperá {FAILURE_WINDOW_MIN} minutos."})
            return

        row = self.store.check_login(name, password)
        if row is None:
            self.throttle.failed("ip:" + ip)
            self.throttle.failed("usuario:" + name.lower())
            log.warning("login fallido: usuario=%s ip=%s", name, ip)
            time.sleep(FAILURE_DELAY_S)
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Usuario o contraseña incorrectos."})
            return

        self.throttle.clear("ip:" + ip)
        self.throttle.clear("usuario:" + name.lower())
        token = self.store.create_session(row["id"], ip, self.headers.get("User-Agent", ""))
        log.info("login: usuario=%s ip=%s", row["nombre"], ip)
        self.send_json(
            HTTPStatus.OK, {"ok": True, "usuario": row["nombre"]},
            [("Set-Cookie", self.cookie_header(token, SESSION_DAYS * 86400))],
        )


def serve(db_path: str, host: str, port: int):
    Handler.store = Store(db_path)
    Handler.throttle = Throttle()

    def purge_loop():
        while True:
            time.sleep(3600)
            try:
                Handler.store.purge_expired()
            except sqlite3.Error as err:
                log.warning("no se pudieron limpiar sesiones vencidas: %s", err)

    threading.Thread(target=purge_loop, daemon=True).start()
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    log.info("escuchando en http://%s:%d, base %s", host, port, db_path)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


# ------------------------------------------------------------------------ CLI

def ask_password(prompt="Contraseña: ") -> str:
    if not sys.stdin.isatty():
        return sys.stdin.readline().rstrip("\n")
    while True:
        first = getpass.getpass(prompt)
        if len(first) < 8:
            print("La contraseña tiene que tener al menos 8 caracteres.", file=sys.stderr)
            continue
        if first == getpass.getpass("Repetir contraseña: "):
            return first
        print("No coinciden; de nuevo.", file=sys.stderr)


class Redes:
    """Las redes del visor (base red.db), para nombrarlas en el CLI. Sin la base, solo números."""

    def __init__(self, ruta):
        self.rows = []
        if ruta and os.path.exists(ruta):
            try:
                c = sqlite3.connect(f"file:{ruta}?mode=ro", uri=True, timeout=5)
                c.row_factory = sqlite3.Row
                self.rows = c.execute("SELECT id, nombre FROM redes ORDER BY nombre COLLATE NOCASE").fetchall()
                c.close()
            except sqlite3.Error as err:
                print(f"(no se pudo leer la base de la red {ruta}: {err}; las redes van por número)", file=sys.stderr)

    def resolver(self, texto: str):
        """'ALVATIC' o '1' -> id; None si no hay tal red."""
        texto = texto.strip()
        por_nombre = [r for r in self.rows if r["nombre"].strip().lower() == texto.lower()]
        if len(por_nombre) == 1:
            return por_nombre[0]["id"]
        if texto.isdigit() and (not self.rows or any(r["id"] == int(texto) for r in self.rows)):
            return int(texto)
        return None

    def nombre(self, red_id: int) -> str:
        for r in self.rows:
            if r["id"] == red_id:
                return f"{r['nombre']} ({red_id})"
        return f"red {red_id}"

    def describir(self, redes) -> str:
        if redes is None:
            return "administra: todas las redes"
        if not redes:
            return "ninguna red"
        return ", ".join(self.nombre(r) for r in redes)


def users_cli(args) -> int:
    store = Store(args.db)
    redes_db = Redes(args.redes_db if args.redes_db is not None else os.path.join(os.path.dirname(args.db), "red.db"))

    def resolver_redes(textos):
        ids = []
        for t in textos:
            red_id = redes_db.resolver(t)
            if red_id is None:
                disponibles = ", ".join(f"{r['nombre']} ({r['id']})" for r in redes_db.rows) or "ninguna todavía"
                print(f"No hay una red «{t}». Redes: {disponibles}.", file=sys.stderr)
                return None
            ids.append(red_id)
        return ids

    if args.accion == "listar":
        rows = store.list_users()
        if not rows:
            print("No hay usuarios.")
        for row in rows:
            print(f"{row['nombre']}\t(creado {row['creado'][:10]})\t{redes_db.describir(redes_lista(row['redes']))}")
        return 0
    name = (args.nombre or "").strip()
    if not name:
        print("Falta el nombre de usuario.", file=sys.stderr)
        return 2
    if args.accion == "agregar":
        if any(r["nombre"] == name for r in store.list_users()):
            print(f"El usuario {name} ya existe (para cambiarle la contraseña: clave {name}).", file=sys.stderr)
            return 1
        redes = None
        if args.red:
            redes = resolver_redes(args.red)
            if redes is None:
                return 1
        password = ask_password(f"Contraseña para {name}: ")
        if len(password) < 8:
            print("La contraseña tiene que tener al menos 8 caracteres.", file=sys.stderr)
            return 1
        store.add_user(name, password, redes)
        print(f"Usuario {name} creado: {redes_db.describir(redes)}.")
    elif args.accion == "redes":
        if args.todas:
            redes = None
        elif args.lista:
            redes = resolver_redes(args.lista)
            if redes is None:
                return 1
        else:
            print(f"Indicá las redes de {name} (por nombre o número) o --todas para que administre.", file=sys.stderr)
            return 2
        if not store.set_redes(name, redes):
            print(f"No existe el usuario {name}.", file=sys.stderr)
            return 1
        print(f"{name}: {redes_db.describir(redes)}.")
    elif args.accion == "clave":
        password = ask_password(f"Nueva contraseña para {name}: ")
        if len(password) < 8:
            print("La contraseña tiene que tener al menos 8 caracteres.", file=sys.stderr)
            return 1
        if not store.set_password(name, password):
            print(f"No existe el usuario {name}.", file=sys.stderr)
            return 1
        print(f"Contraseña de {name} cambiada; sus sesiones abiertas se cerraron.")
    elif args.accion == "quitar":
        if not store.remove_user(name):
            print(f"No existe el usuario {name}.", file=sys.stderr)
            return 1
        print(f"Usuario {name} eliminado.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Servicio de sesión de la plataforma FTTH")
    parser.add_argument("--db", default=os.environ.get("FTTH_AUTH_DB", "/srv/ftth/data/ftth.db"))
    sub = parser.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="atender pedidos (detrás de nginx)")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=int(os.environ.get("FTTH_AUTH_PORT", "8900")))
    u = sub.add_parser("usuarios", help="administrar usuarios",
                       description="listar | agregar NOMBRE [--red RED …] | clave NOMBRE | quitar NOMBRE | redes NOMBRE (RED … | --todas)")
    u.add_argument("accion", choices=["listar", "agregar", "clave", "quitar", "redes"])
    u.add_argument("nombre", nargs="?")
    u.add_argument("lista", nargs="*", help="redes: las redes del usuario, por nombre o número")
    u.add_argument("--red", action="append", help="agregar: una red que va a ver (se puede repetir); sin esto, administra")
    u.add_argument("--todas", action="store_true", help="redes: que administre (ve todas)")
    u.add_argument("--redes-db", default=None, help=argparse.SUPPRESS)  # base de la red, para nombrar las redes
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    if args.cmd == "serve":
        serve(args.db, args.host, args.port)
        return 0
    return users_cli(args)


if __name__ == "__main__":
    sys.exit(main())
