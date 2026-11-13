#!/usr/bin/env python3
"""Carga en olt.db de una instalación de prueba (como el usuario ftth) diez días de historia de la red 1:
cada 5 minutos los últimos 3 días y una por hora antes; ayer a las 14:05 cayeron 7 ONT
del 0/1/2 y volvieron 35 minutos después; el 0/1/1 viene perdiendo potencia."""
import sqlite3
import sys
import time

db = sqlite3.connect(sys.argv[1] if len(sys.argv) > 1 else "/srv/ftth/data/olt.db", timeout=10)
db.execute("DELETE FROM muestras WHERE red = 1 AND t < ?", (int(time.time()) - 900,))
db.execute("DELETE FROM eventos WHERE red = 1")
ahora = int(time.time()) // 300 * 300
PON = {"0/1/0": (14, -21.0, -22.8), "0/1/1": (12, -21.5, -26.4), "0/1/2": (13, -20.3, -21.1), "0/1/3": (11, -21.5, -23.0),
       "0/2/0": (16, -21.2, -22.8)}
dia = time.localtime(ahora - 86400)
corte = int(time.mktime((dia.tm_year, dia.tm_mon, dia.tm_mday, 14, 5, 0, 0, 0, -1)))
filas, t = [], ahora - 10 * 86400
while t < ahora - 600:
    paso = 300 if t >= ahora - 3 * 86400 else 3600
    total_n = total_en = 0
    rxs = []
    for pon, (n, rx, peor) in PON.items():
        en = n
        if pon == "0/1/2" and corte <= t < corte + 2100:
            en = n - 7
        if pon == "0/1/3" and t >= ahora - 2400:
            en = 0
        if pon == "0/1/2" and t >= ahora - 3 * 3600:
            en = n - 6
        if pon == "0/2/0":
            en = n - 2 if t >= ahora - 5 * 3600 else n - 1
        baja = 2.0 * (t - (ahora - 10 * 86400)) / (10 * 86400) if pon == "0/1/1" else 0.0
        ondas = 0.08 * (((t // 300) * 7) % 5 - 2)
        prom = None if en == 0 else round(rx - baja + ondas, 2)
        filas.append((1, "ALVATIC-MA5800-01", pon, t, n, en, prom, None if en == 0 else round(peor - baja + ondas, 2)))
        total_n += n
        total_en += en
        if prom is not None:
            rxs.append((prom, en))
    prom_red = round(sum(p * e for p, e in rxs) / sum(e for _, e in rxs), 2)
    filas.append((1, "", "", t, total_n, total_en, prom_red, -28.6))
    t += paso
db.executemany("INSERT OR IGNORE INTO muestras (red, olt, pon, t, onts, en_linea, rx_prom, rx_min) VALUES (?,?,?,?,?,?,?,?)", filas)
eventos = []
for i in range(7):
    sn = f"HWTC9A0000{0x20 + i:02X}"
    eventos.append((1, corte + i * 4, sn, "ALVATIC-MA5800-01", "0/1/2", "cae", "LOS"))
    eventos.append((1, corte + 2100 + i * 9, sn, "ALVATIC-MA5800-01", "0/1/2", "vuelve", None))
eventos.append((1, ahora - 5 * 3600, "HWTC9A00003C", "ALVATIC-MA5800-01", "0/2/0", "cae", "dying-gasp"))
db.executemany("INSERT INTO eventos (red, t, sn, olt, pon, tipo, causa) VALUES (?,?,?,?,?,?,?)", eventos)
db.commit()
print(len(filas), "muestras y", len(eventos), "eventos")
