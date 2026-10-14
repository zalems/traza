#!/usr/bin/env python3
"""Muestra cómo responden el panel de la OLT (SmartOLT libre) y la API de Wispro.

Sirve para preparar la integración de la 0.6.0. Solo consulta (GET): no cambia nada
en la OLT, en el panel ni en Wispro. Oculta claves, usuarios, direcciones IP y MAC;
de los clientes muestra solo la forma de los textos ("Aaaaa Aaa 999" en vez del nombre
y la dirección) y la ubicación redondeada. El token de Wispro se pide sin mostrarlo en
pantalla y no se guarda en ningún lado.

Uso, en el servidor:
    python3 herramientas/muestras-olt-wispro.py
    python3 herramientas/muestras-olt-wispro.py --olt 2        # otra OLT del panel
    python3 herramientas/muestras-olt-wispro.py --sin-wispro   # solo el panel
"""

import argparse
import getpass
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

WISPRO = "https://www.cloud.wispro.co/api/v1"

# Claves, usuarios y datos de red: no se muestran.
OCULTAR = re.compile(r"community|pass|secret|token|api_?key|user|usuario|login|ssh|snmp|telnet|host|^ip$|_ip$|^ip_|"
                     r"mac|pppoe|netmask|gateway|cred", re.I)
# Datos de personas: se muestra la forma del texto.
PERSONAL = re.compile(r"desc|name|nombre|client|alias|titular|abonado|address|direcc|phone|tel[eé]f|mail|"
                      r"national|taxpayer|dni|cuit|details|city|neighborhood", re.I)
UBICACION = re.compile(r"^(lat|lon|lng)", re.I)
# Identificadores y nombres de equipos o de la red: se muestran.
VISIBLE = re.compile(r"(^|_)id$|^(node|nap|olt|plan|zone|server|board|port)_?name$", re.I)
FTTH = re.compile(r"nap|ont|onu|olt|gpon|pon|serial|fbp|splitter|port|interface", re.I)


def forma(texto):
    """'Gómez Ana 123' -> 'Aaaaa Aaa 999': deja ver el formato sin el contenido."""
    s = "".join("A" if c.isupper() else "a" if c.isalpha() else "9" if c.isdigit() else c for c in str(texto))
    return s if len(s) <= 60 else s[:60] + "…"


def resumir(v, personal=True, decimales=2, nombres_visibles=False):
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            k = str(k)
            if OCULTAR.search(k) and not isinstance(x, (dict, list)):
                out[k] = None if x in (None, "") else f"<oculto: {type(x).__name__}>"
            elif UBICACION.search(k) and x not in (None, ""):
                try:
                    out[k] = round(float(x), decimales)
                except (TypeError, ValueError):
                    out[k] = forma(x)
            elif personal and PERSONAL.search(k) and isinstance(x, str) and not VISIBLE.search(k) \
                    and not (nombres_visibles and k == "name"):
                out[k] = forma(x)
            else:
                out[k] = resumir(x, personal, decimales, nombres_visibles)
        return out
    if isinstance(v, list):
        if len(v) <= 3:
            return [resumir(x, personal, decimales, nombres_visibles) for x in v]
        return [resumir(v[0], personal, decimales, nombres_visibles), resumir(v[1], personal, decimales, nombres_visibles),
                f"... {len(v)} en total; el último:", resumir(v[-1], personal, decimales, nombres_visibles)]
    if isinstance(v, str) and len(v) > 120:
        return v[:120] + "…"
    return v


def imprimir(dato, limite=5000):
    texto = json.dumps(dato, ensure_ascii=False, indent=1, default=str)
    print(texto if len(texto) <= limite else texto[:limite] + "\n…(cortado)")


def lista(v):
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        for k in ("data", "items", "onts", "olts", "results", "rows", "points", "series", "events"):
            if isinstance(v.get(k), list):
                return v[k]
        listas = [x for x in v.values() if isinstance(x, list)]
        if len(listas) == 1:
            return listas[0]
    return []


def pedir(url, cabeceras=None, espera=40):
    inicio = time.monotonic()
    req = urllib.request.Request(url, headers={"Accept": "application/json", **(cabeceras or {})})
    try:
        with urllib.request.urlopen(req, timeout=espera) as r:
            cuerpo = r.read()
            estado = r.status
    except urllib.error.HTTPError as e:
        cuerpo, estado = e.read(), e.code
    except Exception as e:  # sin conexión, nombre, tiempo
        return None, f"{type(e).__name__}: {e}", time.monotonic() - inicio
    try:
        dato = json.loads(cuerpo)
    except ValueError:
        dato = cuerpo[:300].decode("utf-8", "replace")
    return estado, dato, time.monotonic() - inicio


def titulo(texto, estado, segundos):
    print(f"\n== {texto} -> {estado} ({segundos:.1f} s)")


# ----------------------------------------------------------------------------- panel

def panel(base, olt_elegida):
    print(f"######## Panel de la OLT en {base}")
    estado, spec, s = pedir(f"{base}/openapi.json")
    titulo("Parámetros de las consultas GET", estado, s)
    if isinstance(spec, dict):
        for ruta, ops in spec.get("paths", {}).items():
            o = ops.get("get")
            if not o:
                continue
            partes = []
            for p in o.get("parameters", []):
                sch = p.get("schema", {})
                extra = (", obligatorio" if p.get("required") else "") + \
                        (f", por defecto {json.dumps(sch['default'])}" if "default" in sch else "")
                partes.append(f"{p.get('name')} ({p.get('in')}{extra})")
            print("GET", ruta, "|", ", ".join(partes) or "-")

    estado, olts, s = pedir(f"{base}/api/olts")
    titulo("OLTs: GET /api/olts", estado, s)
    imprimir(resumir(olts, personal=False))
    todas = [o for o in lista(olts) if isinstance(o, dict)]
    if olt_elegida is not None:
        olt = next((o for o in todas if str(o.get("id", o.get("olt_id"))) == str(olt_elegida)), None)
        aviso = "" if olt else f" (no encontré la {olt_elegida})"
    else:
        olt = next((o for o in todas if "alvatic" in json.dumps(o, default=str).lower()), None)
        aviso = "" if olt else "; ninguna dice ALVATIC, tomé la primera"
    olt = olt or (todas[0] if todas else None)
    if not olt:
        print("El panel no devolvió OLTs.")
        return
    oid = next((olt[k] for k in ("id", "olt_id", "ref") if k in olt), None)
    print(f"\n(Las muestras siguientes son de la OLT {oid}{aviso})")

    estado, dato, s = pedir(f"{base}/api/olts/{oid}/summary")
    titulo(f"Resumen: GET /api/olts/{oid}/summary", estado, s)
    imprimir(resumir(dato, personal=False))

    estado, dato, s = pedir(f"{base}/api/olts/{oid}/onts")
    titulo(f"ONTs: GET /api/olts/{oid}/onts", estado, s)
    imprimir(resumir(dato))
    onts = [x for x in lista(dato) if isinstance(x, dict)]
    print(f"({len(onts)} ONTs en la lista)")
    if not onts:
        return
    claves = sorted({k for x in onts for k in x})
    print("Campos que aparecen:", ", ".join(claves))
    descripciones = [x.get(k) for x in onts for k in x if re.search(r"desc", k, re.I) and x.get(k)]
    if descripciones:
        print("Forma de las primeras descripciones:")
        for d in descripciones[:10]:
            print("  ", forma(d))
    sns = [x.get(k) for x in onts for k in x if re.search(r"^sn$|serial", k, re.I) and x.get(k)]
    if sns:
        print("Primeros números de serie:", ", ".join(map(str, sns[:3])))

    def en_linea(x):
        return any(str(v).lower() in ("online", "up", "activa", "active", "ok", "true") for v in x.values())

    ont = next((x for x in onts if en_linea(x)), onts[0])
    ref = None
    for k in ("ref", "ont_ref", "id", "sn", "serial"):
        if ont.get(k) in (None, ""):
            continue
        prueba = urllib.parse.quote(str(ont[k]), safe="")
        estado, _, _ = pedir(f"{base}/api/onts/{prueba}")
        print(f"ont_ref con el campo {k} -> {estado}")
        if estado == 200:
            ref = prueba
            break
    if ref:
        for nombre, ruta in (("Una ONT", ""), ("Su óptica", "/optical"), ("Su serie", "/series"), ("Sus eventos", "/events")):
            estado, dato, s = pedir(f"{base}/api/onts/{ref}{ruta}")
            titulo(f"{nombre}: GET /api/onts/{ref}{ruta}", estado, s)
            imprimir(resumir(dato))
    slot = next((ont[k] for k in ("slot", "board") if k in ont), None)
    port = next((ont[k] for k in ("port", "pon", "pon_port") if k in ont), None)
    if slot is not None and port is not None:
        estado, dato, s = pedir(f"{base}/api/olts/{oid}/ports/{slot}/{port}/series")
        titulo(f"Serie de su puerto PON: GET /api/olts/{oid}/ports/{slot}/{port}/series", estado, s)
        imprimir(resumir(dato, personal=False))
    estado, dato, s = pedir(f"{base}/api/thresholds")
    titulo("Umbrales: GET /api/thresholds", estado, s)
    imprimir(resumir(dato, personal=False))


# ----------------------------------------------------------------------------- Wispro

def wispro(base):
    print("\n######## Wispro")
    try:
        token = getpass.getpass("Token de la API de Wispro de ALVATIC (no se ve al escribir; Enter para saltear): ").strip()
    except (EOFError, KeyboardInterrupt):
        token = ""
    if not token:
        print("Sin token: salteo Wispro.")
        return
    cab = {"Authorization": token}

    def get(ruta):
        estado, dato, s = pedir(f"{base}{ruta}", cab)
        cuerpo = dato.get("status") if isinstance(dato, dict) else None
        titulo(f"GET {ruta}", f"{estado}" + (f", status {cuerpo}" if cuerpo not in (None, estado) else ""), s)
        if isinstance(dato, dict) and dato.get("message"):
            print("Mensaje:", dato.get("message"))
        return dato if isinstance(dato, dict) else {}

    def paginas(dato):
        return (dato.get("meta") or {}).get("pagination")

    dato = get("/olts?per_page=100")
    if dato.get("status") == 401:
        print("Wispro no aceptó el token. Revisalo (Configuración avanzada → ISP) y volvé a correr el comando.")
        return
    print("Paginación:", paginas(dato))
    imprimir(resumir(dato.get("data"), personal=True, nombres_visibles=True))

    dato = get("/naps?per_page=1000")
    naps = [n for n in (dato.get("data") or []) if isinstance(n, dict)]
    print("Paginación:", paginas(dato))
    print(f"{len(naps)} NAPs; con ubicación: {sum(1 for n in naps if n.get('latitude') not in (None, ''))}; "
          f"con OLT: {sum(1 for n in naps if n.get('olt_id'))}; "
          f"con contratos: {sum(1 for n in naps if (n.get('contracts_count') or 0) > 0)}; "
          f"contratos en total: {sum(n.get('contracts_count') or 0 for n in naps)}")
    print("Primeros nombres:", ", ".join(str(n.get("name")) for n in naps[:15]))
    print("Valores de fbp:", ", ".join(str(n.get("fbp")) for n in naps[:15]))
    imprimir(resumir(naps[:2], personal=True, decimales=4, nombres_visibles=True))

    con = sorted((n for n in naps if (n.get("contracts_count") or 0) > 0), key=lambda n: n.get("contracts_count"))
    contrato = None
    if con:
        nap = con[0]
        dato = get(f"/contracts?nap_id_eq={urllib.parse.quote(str(nap.get('id')))}&per_page=1000")
        contratos = [c for c in (dato.get("data") or []) if isinstance(c, dict)]
        print("Paginación:", paginas(dato))
        print(f"La NAP {nap.get('name')} dice {nap.get('contracts_count')} contratos; el filtro devolvió {len(contratos)}.")
        if contratos:
            contrato = contratos[0]
            print("Campos del contrato:", ", ".join(sorted(contrato)))
            ftth = {k: v for k, v in contrato.items() if FTTH.search(k) and not OCULTAR.search(k)}
            print("Campos de fibra:", json.dumps(ftth, ensure_ascii=False, default=str))
            imprimir(resumir(contrato))
    if contrato:
        dato = get(f"/contracts/{contrato.get('id')}/status_ont")
        imprimir(resumir(dato, personal=False))

    dato = get("/contracts?per_page=1")
    print("Paginación de todos los contratos:", paginas(dato))
    dato = get("/clients?per_page=1")
    print("Paginación de los clientes:", paginas(dato))
    clientes = dato.get("data") or []
    if clientes and isinstance(clientes[0], dict):
        print("Campos del cliente:", ", ".join(sorted(clientes[0])))


def main():
    ap = argparse.ArgumentParser(description="Muestras del panel de la OLT y de Wispro (solo lectura).")
    ap.add_argument("--panel", default="http://10.10.0.230:8080", help="dirección del panel de la OLT")
    ap.add_argument("--olt", help="id de la OLT del panel para las muestras (por defecto, la de ALVATIC)")
    ap.add_argument("--wispro", default=WISPRO, help=argparse.SUPPRESS)
    ap.add_argument("--sin-wispro", action="store_true", help="no consultar Wispro")
    args = ap.parse_args()
    panel(args.panel.rstrip("/"), args.olt)
    if not args.sin_wispro:
        wispro(args.wispro.rstrip("/"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
