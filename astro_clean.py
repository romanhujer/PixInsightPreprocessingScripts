#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import shutil

# --- KONFIGURACE ---
DRY_RUN = True  # True = simulace | False = ostré mazání

PROTECTED_NAMES = ["master", "final"]
JUNK_FOLDERS = ["debayered", "weights", "logs"]
# .xisf, .tif, .jpg atd. jsou v kořeni projektu NEDOTKNUTELNÉ
KEEP_EXTENSIONS = [".tif", ".tiff", ".jpg", ".jpeg", ".png", ".xisf"]

def has_data(path):
    if not os.path.isdir(path): return False
    for root, _, files in os.walk(path):
        if any(f.lower().endswith(('.xisf', '.fit', '.fits')) for f in files):
            return True
    return False

def safe_delete_folder(path):
    """Smaže složku, pokud neobsahuje chráněné soubory (TIF, XISF...)."""
    keep_files = []
    for root_dir, _, files in os.walk(path):
        for f in files:
            if any(f.lower().endswith(ext) for ext in KEEP_EXTENSIONS):
                keep_files.append(os.path.join(root_dir, f))
    
    if keep_files:
        print(f"  [POZOR] V {path} jsou chráněné soubory. Mažu jen .fit/.fits balast.")
        if not DRY_RUN:
            for root_dir, _, files in os.walk(path):
                for f in files:
                    if f.lower().endswith((".fit", ".fits")):
                        try: os.remove(os.path.join(root_dir, f))
                        except: pass
    else:
        print(f"  [SMAZAT SLOŽKU] {path}")
        if not DRY_RUN:
            try: shutil.rmtree(path)
            except Exception as e: print(f"  [CHYBA] {e}")

def deep_clean_vault(target_path):
    # --- BEZPEČNOSTNÍ KONTROLA CESTY ---
    full_path = os.path.abspath(target_path)
    if "astro" not in full_path.lower():
        print(f"!!! BEZPEČNOSTNÍ CHYBA: Cesta '{full_path}' neobsahuje klíčové slovo 'Astro' !!!")
        print("Skript se z bezpečnostních důvodů zastavil.")
        return

    print(f"\n--- SPUŠTĚN BEZPEČNÝ ÚKLID (v2.2) ---")
    print(f"Cíl: {full_path}")
    
    for root, dirs, files in os.walk(target_path):
        path_lower = root.lower()
        if any(f"/{name}" in path_lower or f"\\{name}" in path_lower for name in PROTECTED_NAMES):
            continue

        # 1. Junk složky (logs, debayered...)
        for junk in JUNK_FOLDERS:
            if junk in dirs:
                safe_delete_folder(os.path.join(root, junk))

        # 2. Logika mazání na základě hotových dat
        has_m = has_data(os.path.join(root, "master"))
        has_f = has_data(os.path.join(root, "final"))
        has_cal = has_data(os.path.join(root, "calibrated"))
        has_reg = has_data(os.path.join(root, "registered"))

        # Mazání calibrated, pokud už je zaregistrováno
        if has_reg and "calibrated" in dirs:
            safe_delete_folder(os.path.join(root, "calibrated"))

        # Mazání RAW FITů (pokud je hotovo/zkalibrováno)
        if has_m or has_f or has_cal:
            # Složky Flat/Light (jen pokud v nich nejsou TIF/XISF)
            for d in list(dirs):
                if d.lower() in ["light", "flat"]:
                    safe_delete_folder(os.path.join(root, d))
            
            # VOLNÉ .fit soubory v kořeni (Light* a Flat*)
            for f in files:
                f_low = f.lower()
                # PŘÍSNÝ FILTR: musí začínat na Light/Flat A končit pouze .fit/.fits
                if (f_low.startswith("light") or f_low.startswith("flat")) and \
                   f_low.endswith((".fit", ".fits")):
                    
                    print(f"  [SMAZAT FIT SOUBOR] {f}")
                    if not DRY_RUN:
                        try: os.remove(os.path.join(root, f))
                        except: pass

if __name__ == "__main__":
    u_input = input("Zadejte cestu (nebo '.'): ").strip()
    target = os.getcwd() if u_input == "." else u_input.replace('\\ ', ' ')
    
    if os.path.exists(target):
        deep_clean_vault(target)
        if DRY_RUN: print("\n!!! SIMULACE HOTOVA (DRY_RUN=True) !!!")
    else:
        print("Cesta neexistuje!")