#!/usr/bin/env python3
"""Servicio de sesión de la plataforma FTTH.

Un solo archivo, sin dependencias fuera de la biblioteca estándar. Guarda
usuarios y sesiones en SQLite y atiende en 127.0.0.1 detrás de nginx:

  GET  /auth/check    nginx lo consulta (auth_request) antes de servir cada
                      archivo: 200 si la cookie de sesión vale, 401 si no.
  POST /auth/login    usuario y contraseña (JSON) -> cookie de sesión.
  POST /auth/logout   cierra la sesión.
  GET  /auth/session  quién está conectado (para la interfaz).
  GET  /auth/health   el servicio está vivo.

Uso:
  ftth-auth.py serve  [--db RUTA] [--port 8900]
  ftth-auth.py usuarios listar | agregar NOMBRE | clave NOMBRE | quitar NOMBRE [--db RUTA]

Todos los usuarios tienen los mismos permisos.
"""

import argparse
import base64
import getpass
import hashlib
import hmac
import json
import logging
import os
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

COOKIE = "ftth_sesion"
SESSION_DAYS = 30            # duración de una sesión sin uso
EXTEND_AFTER_HOURS = 6       # cada cuánto se renueva el vencimiento de una sesión activa
MAX_FAILURES = 8             # intentos fallidos por IP o por usuario…
FAILURE_WINDOW_MIN = 15      # …en esta ventana, antes de bloquear por el mismo lapso
FAILURE_DELAY_S = 0.4        # pausa tras un intento fallido, para frenar la fuerza bruta
MAX_BODY = 4096

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
    creado  TEXT NOT NULL
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

    # usuarios
    def list_users(self):
        return self.conn().execute("SELECT nombre, creado FROM usuarios ORDER BY nombre").fetchall()

    def add_user(self, name: str, password: str):
        self.conn().execute(
            "INSERT INTO usuarios (nombre, clave, creado) VALUES (?, ?, ?)", (name, hash_password(password), iso(now()))
        )

    def set_password(self, name: str, password: str) -> bool:
        cur = self.conn().execute("UPDATE usuarios SET clave = ? WHERE nombre = ?", (hash_password(password), name))
        if cur.rowcount:
            self.conn().execute(
                "DELETE FROM sesiones WHERE usuario_id = (SELECT id FROM usuarios WHERE nombre = ?)", (name,)
            )
        return cur.rowcount > 0

    def remove_user(self, name: str) -> bool:
        return self.conn().execute("DELETE FROM usuarios WHERE nombre = ?", (name,)).rowcount > 0

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
        """Nombre del usuario de la sesión, o None. Renueva el vencimiento de vez en cuando."""
        if not token:
            return None
        h = self.token_hash(token)
        row = self.conn().execute(
            "SELECT s.token_hash, s.visto, s.vence, u.nombre FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id "
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
        return row["nombre"]

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
        path = urlsplit(self.path).path
        if path == "/auth/check":
            user = self.store.session_user(self.cookie_token())
            if user:
                self.send_response(HTTPStatus.OK)
                self.send_header("X-Usuario", user)
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "sin sesión"})
        elif path == "/auth/session":
            user = self.store.session_user(self.cookie_token())
            if user:
                self.send_json(HTTPStatus.OK, {"usuario": user})
            else:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "sin sesión"})
        elif path == "/auth/health":
            self.send_json(HTTPStatus.OK, {"ok": True})
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "no existe"})

    def do_POST(self):
        path = urlsplit(self.path).path
        if path == "/auth/login":
            self.login()
        elif path == "/auth/logout":
            token = self.cookie_token()
            self.store.delete_session(token)
            self.send_json(HTTPStatus.OK, {"ok": True}, [("Set-Cookie", self.cookie_header("", 0))])
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "no existe"})

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


def users_cli(args) -> int:
    store = Store(args.db)
    if args.accion == "listar":
        rows = store.list_users()
        if not rows:
            print("No hay usuarios.")
        for row in rows:
            print(f"{row['nombre']}\t(creado {row['creado'][:10]})")
        return 0
    name = (args.nombre or "").strip()
    if not name:
        print("Falta el nombre de usuario.", file=sys.stderr)
        return 2
    if args.accion == "agregar":
        if any(r["nombre"] == name for r in store.list_users()):
            print(f"El usuario {name} ya existe (para cambiarle la contraseña: clave {name}).", file=sys.stderr)
            return 1
        password = ask_password(f"Contraseña para {name}: ")
        if len(password) < 8:
            print("La contraseña tiene que tener al menos 8 caracteres.", file=sys.stderr)
            return 1
        store.add_user(name, password)
        print(f"Usuario {name} creado.")
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
    u = sub.add_parser("usuarios", help="administrar usuarios")
    u.add_argument("accion", choices=["listar", "agregar", "clave", "quitar"])
    u.add_argument("nombre", nargs="?")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    if args.cmd == "serve":
        serve(args.db, args.host, args.port)
        return 0
    return users_cli(args)


if __name__ == "__main__":
    sys.exit(main())
