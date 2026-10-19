#!/usr/bin/env python3
"""Muestra cómo responden la API de ISPbrain (v2) y la de SmartOLT.

Sirve para preparar la integración de una red cuyo gestor es ISPbrain y cuya OLT se ve
en SmartOLT. Solo consulta: no cambia nada en ninguno de los dos. Oculta claves,
tokens, direcciones IP y MAC; de los clientes muestra solo la forma de los textos
("Aaaaa Aaa 999" en vez del nombre y la dirección) y la ubicación redondeada. Las
claves se piden sin mostrarlas en pantalla y no se guardan en ningún lado.

Uso, en el servidor:
    python3 herramientas/muestras-ispbrain-smartolt.py --ispbrain EMPRESA --smartolt https://panel.ejemplo.net
        EMPRESA: el subdominio de ISPbrain (https://EMPRESA.ispbrain.io). Pide el usuario y
        la clave de la API (en ISPbrain: menú → Sistema → API) y el token de SmartOLT
        (en SmartOLT: General → API key).
    Con uno solo de los dos parámetros, consulta solo ese.
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

# Claves, usuarios y datos de red: no se muestran.
OCULTAR = re.compile(r"community|pass|secret|token|api_?key|jwt|user|usuario|login|ssh|snmp|telnet|host|^ip$|_ip$|^ip_|"
                     r"mac|pppoe|netmask|gateway|cred|connect_to|server|url", re.I)
# Datos de personas: se muestra la forma del texto.
PERSONAL = re.compile(r"desc|name|nombre|apellido|razon|client|alias|titular|abonado|address|direcc|domicilio|calle|street|"
                      r"phone|tel[eé]f|celular|whatsapp|mail|national|taxpayer|dni|cuit|doc|details|city|neighborhood|barrio|"
                      r"contact|observ|comment|nota|note", re.I)
UBICACION = re.compile(r"^(lat|lon|lng)|latitud|longitud", re.I)
# Identificadores y nombres de equipos o de la red: se muestran.
VISIBLE = re.compile(r"(^|_)id$|^(node|nodo|nap|olt|plan|zone|zona|server|board|port|odb|area|city|ciudad|device|service|"
                     r"servicio|branch|sucursal|type|tipo|status|estado|mode|modo)_?name$|^(nodo|node|nap|caja|odb|zone|zona)$", re.I)


def forma(texto):
    """'Gómez Ana 123' -> 'Aaaaa Aaa 999': deja ver el formato sin el contenido."""
    s = "".join("A" if c.isupper() else "a" if c.isalpha() else "9" if c.isdigit() else c for c in str(texto))
    return s if len(s) <= 60 else s[:60] + "…"


def resumir(v, personal=True, decimales=2):
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            k = str(k)
            if OCULTAR.search(k) and not isinstance(x, (dict, list)):
                out[k] = None if x in (None, "") else f"<oculto: {type(x).__name__}>"
            elif UBICACION.search(k) and x not in (None, "") and not isinstance(x, (dict, list)):
                try:
                    out[k] = round(float(x), decimales)
                except (TypeError, ValueError):
                    out[k] = forma(x)
            elif personal and PERSONAL.search(k) and isinstance(x, str) and not VISIBLE.search(k):
                out[k] = forma(x)
            else:
                out[k] = resumir(x, personal, decimales)
        return out
    if isinstance(v, list):
        if len(v) <= 3:
            return [resumir(x, personal, decimales) for x in v]
        return [resumir(v[0], personal, decimales), resumir(v[1], personal, decimales),
                f"... {len(v)} en total; el último:", resumir(v[-1], personal, decimales)]
    if isinstance(v, str) and len(v) > 120:
        return v[:120] + "…"
    return v


def imprimir(dato, limite=6000):
    texto = json.dumps(dato, ensure_ascii=False, indent=1, default=str)
    print(texto if len(texto) <= limite else texto[:limite] + "\n…(cortado)")


def lista(v):
    """La lista principal de una respuesta, esté donde esté."""
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        for k in ("data", "items", "results", "rows", "onus", "olts", "zones", "odbs", "customers", "connections", "list"):
            if isinstance(v.get(k), list):
                return v[k]
        listas = [x for x in v.values() if isinstance(x, list)]
        if len(listas) == 1:
            return listas[0]
        for x in v.values():
            if isinstance(x, dict):
                adentro = lista(x)
                if adentro:
                    return adentro
    return []


ULTIMOS_LIMITES = {}  # cabeceras X-RateLimit de la última respuesta


def pedir(url, cabeceras=None, datos=None, espera=40):
    """(estado, cuerpo, segundos). datos: dict -> JSON por POST; str -> formulario por POST."""
    inicio = time.monotonic()
    cab = {"Accept": "application/json", **(cabeceras or {})}
    cuerpo_envio = None
    if isinstance(datos, dict):
        cuerpo_envio = json.dumps(datos).encode()
        cab["Content-Type"] = "application/json"
    elif isinstance(datos, str):
        cuerpo_envio = datos.encode()
        cab["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=cuerpo_envio, headers=cab, method="POST" if cuerpo_envio is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=espera) as r:
            cuerpo = r.read()
            estado = r.status
            cab_resp = dict(r.headers)
    except urllib.error.HTTPError as e:
        cuerpo, estado, cab_resp = e.read(), e.code, dict(e.headers)
    except Exception as e:  # sin conexión, nombre, tiempo
        return None, f"{type(e).__name__}: {e}", time.monotonic() - inicio
    try:
        dato = json.loads(cuerpo)
    except ValueError:
        dato = cuerpo[:300].decode("utf-8", "replace")
    ULTIMOS_LIMITES.clear()
    ULTIMOS_LIMITES.update({k: v for k, v in cab_resp.items() if k.lower().startswith("x-ratelimit") or k.lower() == "retry-after"})
    return estado, dato, time.monotonic() - inicio


def titulo(texto, estado, segundos):
    print(f"\n== {texto} -> {estado} ({segundos:.1f} s)")


def campos(filas):
    return ", ".join(sorted({k for x in filas if isinstance(x, dict) for k in x}))


def cuantos(filas, condicion):
    return sum(1 for x in filas if isinstance(x, dict) and condicion(x))


def con_ubicacion(x):
    """Si la fila tiene latitud y longitud con valor (no vacío, no 0)."""
    def vale(v):
        try:
            return v not in (None, "") and abs(float(v)) > 1e-6
        except (TypeError, ValueError):
            return False
    return any(UBICACION.search(k) and vale(v) for k, v in x.items())


def buscar_token(dato, profundidad=0):
    """Un token dentro de la respuesta de auth, esté donde esté."""
    if isinstance(dato, dict):
        for k, v in dato.items():
            if isinstance(v, str) and len(v) >= 16 and re.search(r"token|jwt|access|key", str(k), re.I):
                return v
        for v in dato.values():
            if profundidad < 3:
                t = buscar_token(v, profundidad + 1)
                if t:
                    return t
    if isinstance(dato, str) and profundidad == 0 and len(dato) >= 16 and " " not in dato:
        return dato
    return None


# ----------------------------------------------------------------------------- ISPbrain

def ispbrain(empresa, base=None):
    base = base or f"https://{empresa}.ispbrain.io:4443"
    print(f"######## ISPbrain en {base}")
    try:
        usuario = input("Usuario de la API de ISPbrain (menú → Sistema → API; Enter para saltear): ").strip()
        clave = getpass.getpass("Clave de la API de ISPbrain (no se ve al escribir): ").strip() if usuario else ""
    except (EOFError, KeyboardInterrupt):
        usuario = clave = ""
    if not usuario:
        print("Sin usuario: salteo ISPbrain.")
        return

    # Cómo se piden las credenciales no está documentado: se prueban las formas usuales.
    intentos = [
        ("JSON username/password", {"username": usuario, "password": clave}),
        ("JSON user/password", {"user": usuario, "password": clave}),
        ("JSON email/password", {"email": usuario, "password": clave}),
        ("JSON usuario/clave", {"usuario": usuario, "clave": clave}),
        ("formulario username/password", urllib.parse.urlencode({"username": usuario, "password": clave})),
    ]
    token = None
    for nombre, datos in intentos:
        estado, dato, s = pedir(f"{base}/api/v2/auth", datos=datos)
        titulo(f"POST /api/v2/auth ({nombre})", estado, s)
        imprimir(resumir(dato))
        if estado == 200:
            token = buscar_token(dato)
            if token:
                print("(encontré un token en la respuesta; no se muestra)")
                break
            print("Respondió 200 pero no veo un token en la respuesta.")
    if not token:
        print("No conseguí un token: revisá usuario y clave de la API (y que la API esté habilitada).")
        return

    # Con qué cabecera va el token: también se prueba.
    cabeceras = [("Authorization: Bearer", {"Authorization": f"Bearer {token}"}), ("Authorization", {"Authorization": token}),
                 ("token", {"token": token}), ("x-access-token", {"x-access-token": token}), ("x-api-key", {"x-api-key": token})]
    cab = None
    for nombre, c in cabeceras:
        estado, dato, s = pedir(f"{base}/api/v2/areas", c)
        print(f"GET /api/v2/areas con la cabecera {nombre} -> {estado}")
        if estado == 200:
            cab = c
            break
    if cab is None:
        print("Ninguna cabecera sirvió para /api/v2/areas; sigo con 'Authorization: Bearer' por si el problema es la ruta.")
        cab = cabeceras[0][1]

    # La lista de rutas, si el Swagger la entrega como JSON: primero se mira de dónde la carga la página.
    rutas_spec = []
    estado, pagina, _ = pedir(f"{base}/swagger", cab)
    print(f"\nGET /swagger -> {estado}" + (f" ({len(pagina)} caracteres)" if isinstance(pagina, str) else ""))
    if isinstance(pagina, str):
        for m in re.finditer(r"""(?:url|spec|src|href)\s*[:=]\s*["']([^"']+)["']""", pagina):
            u = m.group(1)
            if re.search(r"json|api-docs|swagger|openapi|spec", u, re.I) and not re.search(r"\.(js|css|png)$", u):
                rutas_spec.append(u)
        print("Rutas que menciona la página:", ", ".join(rutas_spec) or "ninguna con json/swagger")
    rutas_spec += ["/swagger/v1/swagger.json", "/swagger.json", "/swagger/swagger.json", "/swagger/v2/swagger.json",
                   "/api/v2/swagger.json", "/openapi.json", "/api-docs", "/api-docs/swagger.json", "/swagger/json",
                   "/v2/api-docs", "/swagger/api-docs", "/api/v2/docs", "/api/v2/openapi.json", "/swagger/openapi.json"]
    vistas = set()
    for ruta in rutas_spec:
        if ruta in vistas:
            continue
        vistas.add(ruta)
        url = ruta if ruta.startswith("http") else f"{base}{ruta if ruta.startswith('/') else '/' + ruta}"
        estado, spec, s = pedir(url, cab)
        print(f"GET {ruta} -> {estado}")
        if estado == 200 and isinstance(spec, dict) and spec.get("paths"):
            titulo(f"Rutas del Swagger: GET {ruta}", estado, s)
            for p, ops in spec["paths"].items():
                if isinstance(ops, dict):
                    params = []
                    g = ops.get("get") or {}
                    for prm in g.get("parameters", []) if isinstance(g, dict) else []:
                        params.append(f"{prm.get('name')}{'*' if prm.get('required') else ''}")
                    print(" ", ", ".join(m.upper() for m in ops if m in ("get", "post", "put", "delete")), p,
                          f"| GET: {', '.join(params)}" if params else "")
            esquemas = (spec.get("components") or {}).get("schemas") or (spec.get("definitions") or {})
            for k in esquemas:
                props = (esquemas[k] or {}).get("properties") or {}
                if props:
                    print(f"  esquema {k}: {', '.join(props)}")
            break
    else:
        print("El Swagger no entregó el JSON: abrí {base}/swagger en el navegador, tocá Explore y mirá en la pestaña Red "
              "de dónde carga el .json; pasame esa ruta.".replace("{base}", base))

    def get(ruta, mostrar=True):
        estado, dato, s = pedir(f"{base}{ruta}", cab)
        if mostrar:
            titulo(f"GET {ruta}", estado, s)
        return estado, dato

    for ruta in ("/api/v2/areas", "/api/v2/cities", "/api/v2/devices", "/api/v2/plans", "/api/v2/services", "/api/v2/branches",
                 "/api/v2/nodes", "/api/v2/nodos", "/api/v2/boxes", "/api/v2/naps", "/api/v2/olts", "/api/v2/onus",
                 "/api/v2/zones", "/api/v2/sold_services", "/api/v2/sold-services", "/api/v2/soldservices", "/api/v2/services_sold"):
        estado, dato = get(ruta)
        filas = lista(dato)
        if filas:
            print(f"{len(filas)} filas. Campos: {campos(filas)}")
            imprimir(resumir(filas[:2], personal=True), limite=1500)
        elif estado == 200:
            imprimir(resumir(dato), limite=1500)
        else:
            print(json.dumps(resumir(dato), ensure_ascii=False)[:300])

    # Las listas grandes piden paginación, con nombres que no están documentados: se prueban varios.
    paginaciones = ("?page=1&limit=5", "?page=1&per_page=5", "?page=1&page_size=5", "?limit=5&offset=0",
                    "?pagina=1&cantidad=5", "?page=1&size=5", "?page=1&rows=5", "?page=1")
    paginacion = None
    primer_cliente = None
    for nombre, ruta in (("clientes", "/api/v2/customers"), ("conexiones", "/api/v2/connections")):
        for sufijo in ([paginacion] if paginacion else paginaciones):
            estado, dato = get(ruta + sufijo)
            if estado != 200:
                print("  ", json.dumps(resumir(dato), ensure_ascii=False)[:200])
                continue
            paginacion = sufijo
            filas = lista(dato)
            print(f"{nombre}: {len(filas)} filas en la respuesta. Campos: {campos(filas)}")
            if isinstance(dato, dict):
                print("Claves de la respuesta (fuera de la lista):",
                      json.dumps({k: v for k, v in dato.items() if not isinstance(v, (list, dict))}, ensure_ascii=False)[:300])
            imprimir(resumir(filas[:2] if filas else dato, personal=True, decimales=3), limite=5000)
            if filas:
                print(f"  con ubicación: {cuantos(filas, con_ubicacion)}"
                      f"; con nodo/caja: {cuantos(filas, lambda x: any(re.search(r'nodo|node|nap|caja|box|odb', k, re.I) and x.get(k) for k in x))}"
                      f"; con ONU/serie/MAC: {cuantos(filas, lambda x: any(re.search(r'onu|ont|serial|mac', k, re.I) and x.get(k) for k in x))}")
                if nombre == "clientes" and isinstance(filas[0], dict):
                    primer_cliente = filas[0].get("id")
            break
    if not paginacion:
        print("Ninguna forma de paginación sirvió: hay que mirar el Swagger.")
    # Un cliente con sus conexiones y servicios, para ver cómo se relacionan.
    if primer_cliente is not None:
        for ruta in (f"/api/v2/customers/{primer_cliente}", f"/api/v2/customers/{primer_cliente}/connections",
                     f"/api/v2/customers/{primer_cliente}/services", f"/api/v2/customers/{primer_cliente}/balance",
                     f"/api/v2/connections{paginacion}&customer_id={primer_cliente}"):
            estado, dato = get(ruta)
            imprimir(resumir(dato, personal=True, decimales=3), limite=3000)


# ----------------------------------------------------------------------------- SmartOLT

def smartolt(base):
    print(f"\n######## SmartOLT en {base}")
    try:
        token = getpass.getpass("Token de la API de SmartOLT (General → API key; no se ve al escribir; Enter para saltear): ").strip()
    except (EOFError, KeyboardInterrupt):
        token = ""
    if not token:
        print("Sin token: salteo SmartOLT.")
        return
    cab = {"X-Token": token}

    def get(ruta, personal=True):
        estado, dato, s = pedir(f"{base}{ruta}", cab)
        titulo(f"GET {ruta}", estado, s)
        if ULTIMOS_LIMITES:
            print("Límites:", json.dumps(ULTIMOS_LIMITES))
        if isinstance(dato, dict) and dato.get("status") is False:
            print("Respuesta:", json.dumps(resumir(dato), ensure_ascii=False))
        return dato

    dato = get("/api/system/get_olts", personal=False)
    olts = [o for o in lista(dato) if isinstance(o, dict)]
    imprimir(resumir(dato, personal=False))
    if not olts and not isinstance(dato, dict):
        print("SmartOLT no respondió como API: revisá la dirección y el token.")
        return
    dato = get("/api/system/get_zones", personal=False)
    zonas = [z for z in lista(dato) if isinstance(z, dict)]
    print(f"{len(zonas)} zonas. Campos: {campos(zonas)}")
    print("Nombres de las zonas:", " | ".join(str(z.get("name")) for z in zonas))
    dato = get("/api/system/get_odbs")
    odbs = [o for o in lista(dato) if isinstance(o, dict)]
    print(f"{len(odbs)} ODB (cajas/splitters). Campos: {campos(odbs)}")
    if odbs:
        print(f"  con ubicación: {cuantos(odbs, con_ubicacion)}")
        print("  todas (nombre, puertos, zona, ubicación redondeada):")
        for o in odbs:
            u = f"{round(float(o['latitude']), 3)},{round(float(o['longitude']), 3)}" if con_ubicacion(o) else "sin ubicación"
            print(f"    {o.get('name')} | {o.get('nr_of_ports')} p | {o.get('zone_name')} | {u}"
                  + (f" | {forma(o.get('comment'))}" if o.get("comment") else ""))
        imprimir(resumir(odbs[:1], personal=False, decimales=3))

    onus = []
    pagina, total_paginas = 1, 1
    while pagina <= total_paginas and pagina <= 30:
        dato = get(f"/api/onu/get_all_onus_details?page={pagina}&page_size=100", personal=True) if pagina == 1 \
            else pedir(f"{base}/api/onu/get_all_onus_details?page={pagina}&page_size=100", cab)[1]
        parte = [o for o in lista(dato) if isinstance(o, dict)]
        if pagina == 1 and isinstance(dato, dict):
            print("Claves de la respuesta:", ", ".join(k for k in dato if not isinstance(dato[k], list)),
                  "| total_items:", dato.get("total_items"), "| total_pages:", dato.get("total_pages"))
            try:
                total_paginas = int(dato.get("total_pages") or 1)
            except (TypeError, ValueError):
                total_paginas = 1
        if not parte:
            break
        onus += parte
        pagina += 1
    print(f"{len(onus)} ONUs en total ({pagina - 1} páginas). Campos: {campos(onus)}")
    if onus:
        print(f"  con odb_name: {cuantos(onus, lambda x: x.get('odb_name'))}; con odb_port: {cuantos(onus, lambda x: x.get('odb_port'))}"
              f"; con ubicación: {cuantos(onus, con_ubicacion)}"
              f"; con dirección: {cuantos(onus, lambda x: x.get('address'))}; con nombre: {cuantos(onus, lambda x: x.get('name'))}"
              f"; con contacto: {cuantos(onus, lambda x: x.get('contact'))}")
        print("  estados:", json.dumps({s: cuantos(onus, lambda x, s=s: x.get('status') == s) for s in {str(o.get('status')) for o in onus}}))
        print("  por OLT:", json.dumps({str(o.get('olt_name')): cuantos(onus, lambda x, o=o: x.get('olt_id') == o.get('olt_id')) for o in onus}))
        por_zona = {}
        for o in onus:
            por_zona[str(o.get("zone_name"))] = por_zona.get(str(o.get("zone_name")), 0) + 1
        print("  ONUs por zona:", json.dumps(por_zona, ensure_ascii=False))
        por_odb = {}
        for o in onus:
            if o.get("odb_name"):
                por_odb[str(o.get("odb_name"))] = por_odb.get(str(o.get("odb_name")), 0) + 1
        print("  ONUs por ODB:", json.dumps(por_odb, ensure_ascii=False))
        por_pon = {}
        for o in onus:
            k = f"{o.get('board')}/{o.get('port')}"
            por_pon[k] = por_pon.get(k, 0) + 1
        print("  ONUs por placa/puerto PON:", json.dumps(por_pon))
        print("  forma de los primeros nombres de ONU:", "; ".join(forma(o.get("name")) for o in onus[:8] if o.get("name")))
        print("  forma de las primeras direcciones:", "; ".join(forma(o.get("address")) for o in onus[:8] if o.get("address")))
        print("  forma de los primeros contactos:", "; ".join(forma(o.get("contact")) for o in onus if o.get("contact"))[:300])
        imprimir(resumir(onus[:1], personal=True, decimales=3), limite=2500)

    dato = get("/api/onu/get_onus_signals")
    senales = [o for o in lista(dato) if isinstance(o, dict)]
    print(f"{len(senales)} ONUs con señal. Campos: {campos(senales)}")
    if senales:
        print(f"  con signal_1490: {cuantos(senales, lambda x: x.get('signal_1490'))}; con signal_1310: {cuantos(senales, lambda x: x.get('signal_1310'))}")
        imprimir(resumir(senales[:2], personal=True))
    dato = get("/api/onu/get_onus_statuses")
    estados = [o for o in lista(dato) if isinstance(o, dict)]
    print(f"{len(estados)} ONUs con estado. Campos: {campos(estados)}")
    imprimir(resumir(estados[:2], personal=True))
    if onus:
        ref = onus[0].get("unique_external_id")
        if ref:
            for ruta in (f"/api/onu/get_onu_details/{ref}", f"/api/onu/get_onu_status_history/{ref}",
                         f"/api/onu/get_onu_signal/{ref}", f"/api/onu/get_onu_full_status_info/{ref}"):
                dato = get(ruta)
                imprimir(resumir(dato, personal=True), limite=2500)


def main():
    ap = argparse.ArgumentParser(description="Muestras de ISPbrain y SmartOLT (solo lectura).")
    ap.add_argument("--ispbrain", metavar="EMPRESA", help="subdominio de ISPbrain (EMPRESA.ispbrain.io)")
    ap.add_argument("--smartolt", metavar="URL", help="dirección de SmartOLT (https://panel.ejemplo.net)")
    ap.add_argument("--ispbrain-url", help=argparse.SUPPRESS)  # para probar contra un ISPbrain falso
    args = ap.parse_args()
    if not args.ispbrain and not args.smartolt:
        ap.error("indicá --ispbrain EMPRESA, --smartolt URL o los dos")
    if args.ispbrain:
        ispbrain(re.sub(r"^https?://|\.ispbrain\.io.*$|/.*$", "", args.ispbrain.strip()), args.ispbrain_url)
    if args.smartolt:
        smartolt(args.smartolt.strip().rstrip("/"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
