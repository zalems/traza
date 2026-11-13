#!/usr/bin/env python3
"""Muestra todo lo que entrega el panel de la OLT (SmartOLT libre), para sumarlo a traza.

Lee la descripción que el panel publica de sí mismo (/openapi.json), lista todas sus
rutas y consulta las de lectura para ver qué forma tiene cada respuesta: placas,
puertos PON (potencia del SFP), uplinks y tráfico, series, eventos.

Solo consulta (GET) y solo al panel, nunca a la OLT:
  - lo que no es GET (reiniciar, autorizar, comandos) se lista y no se llama;
  - un GET que por su nombre parece leer la OLT en el momento o ejecutar algo
    (en vivo, ssh, comandos, diagnóstico…) tampoco se llama: se lista con el motivo.
Oculta claves, comunidades SNMP, usuarios, direcciones IP y MAC; de los clientes
muestra solo la forma de los textos ("Aaaaa Aaa 999").

Uso, en el servidor de traza (el contenedor 240):
    python3 herramientas/muestras-panel.py                 # la primera OLT del panel
    python3 herramientas/muestras-panel.py --olt 1         # la OLT 1
    python3 herramientas/muestras-panel.py --sin-llamar    # solo la lista de rutas
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Claves, usuarios y datos de red: no se muestran.
OCULTAR = re.compile(r"community|pass|secret|token|api_?key|user|usuario|login|ssh|snmp|telnet|host|^ip$|_ip$|^ip_|"
                     r"mac|pppoe|netmask|gateway|cred", re.I)
# Datos de personas: se muestra la forma del texto.
PERSONAL = re.compile(r"desc|name|nombre|client|alias|titular|abonado|address|direcc|phone|tel[eé]f|mail|"
                      r"national|taxpayer|dni|cuit|details|city|neighborhood", re.I)
UBICACION = re.compile(r"^(lat|lon|lng)", re.I)
# Nombres de equipos o de la red: se muestran.
VISIBLE = re.compile(r"(^|_)id$|^(node|olt|zone|server|board|port|vendor|model|type|profile|vlan|line|srv)_?(name|type)?$|"
                     r"^(event_type|run_state|rx_status|technology|status|state|kind|unit)$", re.I)
# Un GET con esto en la ruta o en su descripción puede abrir una sesión en la OLT: no se llama.
NO_LLAMAR = re.compile(r"live|vivo|ssh|cli\b|command|comando|exec|action|accion|diag|reboot|reinici|reset|authori|autoriz|"
                       r"sweep|barrid|refresh|refresc|poll|sync|ping|test|trace|\brun\b|start|stop|export|download|descarg|"
                       r"apply|aplic|provision|delete|borr|write|config", re.I)
MAX_LLAMADAS = 60
ESPERA = 20


def forma(texto):
    """'Gómez Ana 123' -> 'Aaaaa Aaa 999': deja ver el formato sin el contenido."""
    s = "".join("A" if c.isupper() else "a" if c.isalpha() else "9" if c.isdigit() else c for c in str(texto))
    return s if len(s) <= 40 else s[:40] + "…"


def resumir(v, nivel=0):
    """Una respuesta, achicada: de las listas, el primero y el último; sin secretos ni datos de personas."""
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            k = str(k)
            if OCULTAR.search(k) and not isinstance(x, (dict, list)):
                out[k] = None if x in (None, "") else f"<oculto: {type(x).__name__}>"
            elif UBICACION.search(k) and x not in (None, ""):
                try:
                    out[k] = round(float(x), 2)
                except (TypeError, ValueError):
                    out[k] = forma(x)
            elif PERSONAL.search(k) and isinstance(x, str) and not VISIBLE.search(k):
                out[k] = forma(x)
            else:
                out[k] = resumir(x, nivel + 1)
        return out
    if isinstance(v, list):
        if len(v) <= 2:
            return [resumir(x, nivel + 1) for x in v]
        return [resumir(v[0], nivel + 1), f"... {len(v)} en total; el último:", resumir(v[-1], nivel + 1)]
    if isinstance(v, str) and len(v) > 80:
        return v[:80] + "…"
    return v


def imprimir(dato, limite=1800):
    texto = json.dumps(dato, ensure_ascii=False, indent=1, default=str)
    print(texto if len(texto) <= limite else texto[:limite] + "\n…(cortado)")


def lista(v):
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        for k in ("data", "items", "onts", "olts", "results", "rows"):
            if isinstance(v.get(k), list):
                return v[k]
    return []


def pedir(url):
    """GET de un JSON: (estado, dato, segundos). Nunca otro método."""
    inicio = time.monotonic()
    req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=ESPERA) as r:
            cuerpo, estado = r.read(8 * 1024 * 1024), r.status
    except urllib.error.HTTPError as e:
        cuerpo, estado = e.read(64 * 1024), e.code
    except Exception as e:  # sin conexión, nombre, tiempo
        return None, f"{type(e).__name__}: {e}", time.monotonic() - inicio
    try:
        dato = json.loads(cuerpo)
    except ValueError:
        dato = cuerpo[:200].decode("utf-8", "replace")
    return estado, dato, time.monotonic() - inicio


def esquema(spec, s, nivel=0):
    """Un esquema de OpenAPI en una línea: {campo: tipo, …}."""
    if not isinstance(s, dict) or nivel > 3:
        return "?"
    if "$ref" in s:
        nombre = str(s["$ref"]).rsplit("/", 1)[-1]
        destino = (spec.get("components") or {}).get("schemas", {}).get(nombre)
        return f"{nombre} {esquema(spec, destino, nivel + 1)}" if isinstance(destino, dict) else nombre
    for clave in ("anyOf", "oneOf", "allOf"):
        if isinstance(s.get(clave), list):
            return " | ".join(esquema(spec, x, nivel + 1) for x in s[clave][:4])
    if s.get("type") == "array":
        return f"[{esquema(spec, s.get('items'), nivel + 1)}]"
    props = s.get("properties")
    if isinstance(props, dict):
        return "{" + ", ".join(f"{k}: {esquema(spec, v, nivel + 1)}" for k, v in list(props.items())[:40]) + "}"
    return str(s.get("type") or s.get("title") or "?")


def parametros(op, comunes):
    return [p for p in list(comunes or []) + list(op.get("parameters") or []) if isinstance(p, dict)]


def describir(spec, metodo, ruta, op, comunes):
    partes = []
    for p in parametros(op, comunes):
        sch = p.get("schema") or {}
        extra = (", obligatorio" if p.get("required") else "") + (f", por defecto {json.dumps(sch['default'])}" if "default" in sch else "")
        partes.append(f"{p.get('name')} ({p.get('in')}{extra})")
    linea = f"{metodo.upper():6} {ruta} | {', '.join(partes) or '-'}"
    titulo = " ".join(str(op.get(k) or "") for k in ("summary",)).strip()
    if titulo:
        linea += f" | {titulo[:90]}"
    print(linea)
    cuerpo = (((op.get("requestBody") or {}).get("content") or {}).get("application/json") or {}).get("schema")
    if cuerpo:
        print(f"       cuerpo: {esquema(spec, cuerpo)[:300]}")
    resp = ((((op.get("responses") or {}).get("200") or {}).get("content") or {}).get("application/json") or {}).get("schema")
    if isinstance(resp, dict) and resp and esquema(spec, resp) not in ("?", "object"):
        print(f"       responde: {esquema(spec, resp)[:400]}")


def main():
    ap = argparse.ArgumentParser(description="Muestras de todo lo que entrega el panel de la OLT (solo lectura).")
    ap.add_argument("--panel", default="http://10.10.0.230:8080", help="dirección del panel de la OLT")
    ap.add_argument("--olt", help="número de la OLT del panel para las muestras (por defecto, la primera)")
    ap.add_argument("--sin-llamar", action="store_true", help="solo lista las rutas, sin consultar ninguna")
    args = ap.parse_args()
    base = args.panel.rstrip("/")
    print(f"######## Panel de la OLT en {base}")

    estado, spec, s = pedir(f"{base}/openapi.json")
    if not isinstance(spec, dict) or not isinstance(spec.get("paths"), dict):
        print(f"El panel no entregó su descripción (/openapi.json -> {estado}: {str(spec)[:200]}).")
        print("Revisá la dirección con --panel, o que el panel esté andando.")
        return 1
    info = spec.get("info") or {}
    print(f"{info.get('title', '?')} {info.get('version', '')} · {len(spec['paths'])} rutas ({s:.1f} s)")

    print("\n== Todas las rutas (método, ruta | parámetros | qué dice que hace)")
    lecturas, otras = [], 0
    for ruta, ops in spec["paths"].items():
        if not isinstance(ops, dict):
            continue
        for metodo in ("get", "post", "put", "patch", "delete"):
            op = ops.get(metodo)
            if not isinstance(op, dict):
                continue
            describir(spec, metodo, ruta, op, ops.get("parameters"))
            if metodo == "get":
                lecturas.append((ruta, op, ops.get("parameters")))
            else:
                otras += 1
    print(f"\n{len(lecturas)} de lectura (GET) y {otras} que cambian algo (esas no se llaman).")
    if args.sin_llamar:
        return 0

    # Con qué completar las rutas: una OLT, una ONT en línea y su placa y puerto.
    estado, olts, s = pedir(f"{base}/api/olts")
    todas = [o for o in lista(olts) if isinstance(o, dict)]
    print(f"\n== OLTs: GET /api/olts -> {estado} ({s:.1f} s)")
    imprimir(resumir(olts))
    olt = next((o for o in todas if str(o.get("id")) == str(args.olt)), None) if args.olt is not None else (todas[0] if todas else None)
    if olt is None:
        print("No encontré esa OLT en el panel." if args.olt is not None else "El panel no devolvió OLTs.")
        return 1
    oid = olt.get("id")
    estado, dato, s = pedir(f"{base}/api/olts/{oid}/onts?limit=50")
    onts = [x for x in lista(dato) if isinstance(x, dict)]
    ont = next((x for x in onts if str(x.get("run_state")).lower() == "online"), onts[0] if onts else {})
    print(f"\n(Las muestras son de la OLT {oid}; de sus ONT se toma una en línea: id {ont.get('id')}, placa {ont.get('slot')}, puerto {ont.get('port')})")
    if onts:
        print("Campos de una ONT:", ", ".join(sorted({k for x in onts for k in x})))

    valores = {}
    for nombres, valor in ((("olt_id", "olt", "oid"), oid), (("ont_id", "ont", "ont_ref", "ref", "onu_id"), ont.get("id")),
                           (("slot", "board", "board_id", "slot_id"), ont.get("slot")), (("port", "pon", "pon_port", "port_id"), ont.get("port")),
                           (("frame",), ont.get("frame", 0)), (("sn", "serial"), ont.get("sn"))):
        for n in nombres:
            valores[n] = valor

    hechas, salteadas = 0, []
    for ruta, op, comunes in lecturas:
        if ruta in ("/openapi.json", "/docs", "/redoc") or not ruta.startswith("/api"):
            continue
        texto = " ".join(str(op.get(k) or "") for k in ("summary", "description", "operationId"))
        if NO_LLAMAR.search(ruta) or NO_LLAMAR.search(texto):
            salteadas.append((ruta, "parece leer la OLT en el momento o ejecutar algo"))
            continue
        final, falta = ruta, None
        for nombre in re.findall(r"\{([^}]+)\}", ruta):
            clave = nombre if nombre in valores else ("olt_id" if nombre == "id" and ruta.startswith("/api/olts/") else
                                                      "ont_id" if nombre == "id" and ruta.startswith("/api/onts/") else None)
            if clave is None or valores.get(clave) in (None, ""):
                falta = nombre
                break
            final = final.replace("{" + nombre + "}", urllib.parse.quote(str(valores[clave]), safe=""))
        if falta:
            salteadas.append((ruta, f"no sé qué poner en {{{falta}}}"))
            continue
        consulta = {}
        for p in parametros(op, comunes):
            if p.get("in") != "query":
                continue
            nombre = str(p.get("name"))
            if nombre in ("limit", "per_page", "page_size", "size", "top", "n"):
                consulta[nombre] = 3
            elif nombre == "hours":
                consulta[nombre] = 24
            elif nombre == "buckets":
                consulta[nombre] = 6
            elif p.get("required"):
                falta = nombre
        if falta:
            salteadas.append((ruta, f"pide el parámetro {falta}"))
            continue
        if hechas >= MAX_LLAMADAS:
            salteadas.append((ruta, "ya se consultaron muchas; se puede volver a correr"))
            continue
        url = f"{base}{final}" + (f"?{urllib.parse.urlencode(consulta)}" if consulta else "")
        estado, dato, s = pedir(url)
        hechas += 1
        print(f"\n== GET {final}{'?' + urllib.parse.urlencode(consulta) if consulta else ''} -> {estado} ({s:.1f} s)")
        if isinstance(dato, list):
            print(f"lista de {len(dato)}" + (f"; campos: {', '.join(sorted({k for x in dato if isinstance(x, dict) for k in x}))}" if dato else ""))
        imprimir(resumir(dato))
        time.sleep(0.2)

    if salteadas:
        print("\n== Lecturas que no se consultaron")
        for ruta, motivo in salteadas:
            print(f"GET {ruta}: {motivo}")
    print(f"\nListo: {hechas} lecturas consultadas, {len(salteadas)} sin consultar. Nada se cambió en el panel ni en la OLT.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
